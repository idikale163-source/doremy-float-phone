# 自定义 APP 接入「通话语音留档」开发要点

> **面向**：给 AI 虚拟手机写自定义 APP 的人（和他的 AI）。
> **目标**：让你的 APP 能**复听通话当时的原音**，而不是每次重新合成。
> **前提**：站点部署了「通话语音留档」改动（见 `docs/call-feature-updates.md`）。
> 没部署也能跑——会自动降级为重新合成，见 §五。

---

## 一、这份能力解决什么

通话里角色的每句话都是 TTS 现场合成的。早期实现合成完就丢（只放内存 Map，挂断即失），
所以「通话结束后想复听当时那句」只有一条路：**重新合成**——音色、语速、情绪每次都可能不同，
还重复消耗语音额度。

留档改动把合成结果落进媒体库，并把一个引用写进那条消息的 `mediaData`。
自定义 APP 读到引用后，可以**直接播放当时的原音**。

```
通话屏 TTS 合成 → 落媒体库（storeMediaBlob）→ media-store:// 引用
                                   ↓
                    写进消息 mediaData.callAudioRef
                                   ↓
              APP: chat.readHistory 读到引用 → voice.play 直接播
```

**宿主 API 零改动**——这是设计时就打通的两条既有通道：
`serializeChatMessage` 整包透传 `mediaData`；`voice.play` 本就支持 `media-store://` 引用。

---

## 二、数据长什么样

`AiPhone.chat.readHistory({ characterId, limit, before })` 返回里，通话消息带 `origin: "call"`，
`mediaData` 上可能有这些字段：

| 字段 | 含义 |
|---|---|
| `callAudioRef` | **原音留档引用**（`media-store://…`）。有它就能放原音 |
| `callDuration` | 通话时长文本（如 `"12:03"`），挂在挂断留痕那条上 |
| `callStartMarker` | 用户手动标的「通话开头」（布尔） |
| `callEndMarker` | 用户手动标的「通话结尾」（布尔） |

一条带留档的通话消息大概长这样：

```js
{
  id: "msg_...",
  role: "assistant",
  content: "宝宝，你这是……",
  origin: "call",
  createdAt: "2026-10-09T04:39:12.000Z",
  mediaData: {
    callAudioRef: "media-store://mc_1759..."
  }
}
```

**三点注意**：

1. `callAudioRef` 只挂在**有台词**的消息上。贴纸、红包这类没有朗读内容的消息不挂。
2. 老通话（留档功能上线前打的）**永远没有这个字段**——这是数据本身的限制，不是 bug。
3. 留档会被**自动清理**（默认保留最近 30 天 / 400 段），所以昨天有、今天可能就没了。

---

## 三、怎么播（核心代码）

```js
// 1. 读聊天历史
const res = await AiPhone.chat.readHistory({ characterId, limit: 200 });
const messages = res.messages || [];

// 2. 找出有留档的通话消息
const withAudio = messages.filter(m =>
  m.origin === "call" &&
  m.mediaData &&
  typeof m.mediaData.callAudioRef === "string"
);

// 3. 播放：把引用直接交给宿主代播
await AiPhone.voice.play({ dataUrl: withAudio[0].mediaData.callAudioRef });
// 播完才 resolve；期间可以显示「播放中」
```

**四个要点**：

- **直接传引用，不要先转 dataURL。** `voice.play` 内部会自己 `loadMediaBlob` 转 objectURL，
  音频数据**不经过沙盒通信桥**——这是大文件不卡的关键。
- **必须用 `voice.play`（宿主代播），不要自己建 `<audio>`。** APP 跑在沙盒 iframe（空源）里，
  自建 `<audio>` 会让 iOS 锁屏媒体卡片绑到打不开的空白地址（用户一点整个应用白屏）；
  Web Audio 又会被 iOS 静音拨键整个静音。宿主代播没这两个坑。
- **`voice.play` 播完才 resolve**，可以直接 `await` 来驱动播放态。
- **停止播放**用 `AiPhone.voice.stopPlayback({})`。两个通道：`voice`（默认）/ `ambience`。

---

## 四、权限

| 权限 | 干什么 | 何时需要 |
|---|---|---|
| `chat.read` | 读聊天历史（拿 `callAudioRef`） | 必填 |
| `voice.tts` | 语音合成，以及**宿主代播**（`voice.play` 走这个权限） | 必填 |
| `characters.read` | 拿角色名 / 头像 | 按需 |

装 APP 时用户会看到「调用语音合成（消耗你的语音额度）」。**播放已有原音其实不消耗额度**
（不走 TTS API），但这条权限是宿主代播的入口，没有更细的粒度——
建议在 APP 里说明一句，避免用户疑惑「一个统计 APP 为什么要语音权限」。

---

## 五、对方没部署留档改动怎么办（分享前必读）

如果你要把 APP 分享给别人，对方的站点**很可能没部署留档改动**。
这时 `callAudioRef` 永远是 undefined，**不能让 APP 报错或空白**。

**降级路径**：没有留档 → 用 `voice.tts` 现场重新合成。

```js
async function replay(message, characterId) {
  const ref = message.mediaData && message.mediaData.callAudioRef;
  if (ref) {
    await AiPhone.voice.play({ dataUrl: ref });   // 放原音
    return { mode: "origin" };
  }
  const text = String(message.content || "").trim();
  if (!text) return { mode: "none" };
  const speech = await AiPhone.voice.tts({ characterId, text });
  if (!speech || !speech.dataUrl) return { mode: "failed" };
  await AiPhone.voice.play({ dataUrl: speech.dataUrl });
  return { mode: "synthesized" };
}
```

**文案要中性。** 别写「旧版本打的电话」——对没部署的站点，用户每一条都是这个状态，
那句话会让人以为自己数据坏了。改成类似：

> 复听会优先播放通话当时的原音；当前站点未启用语音留档，将按原句重新合成。

**建议**：给这两种状态一个可见的小区分（比如播放按钮换个样式 / 气泡上标「原音」），
让用户知道差别在哪。

---

## 六、踩过的坑

### 坑 1 · 沙盒 iframe 里 `localStorage` 用不了 ★★

APP 跑在**空源**的 sandbox iframe 里（宿主故意不给 same-origin，否则别人的 APP 就能读你
整个小手机的数据）。这种不透明源下，浏览器**直接拒绝访问 `localStorage`**，抛 `SecurityError`。

危险的是：如果按常规写法包了 `try/catch`——

```js
// 静默失败：不报错，但也从没存进去过
try { localStorage.setItem(k, v) } catch (e) {}
```

它**没有任何错误信息**，表现只是「每次进 APP 设置都丢」。真实案例：一个 APP 的主题色
每次都要重选，根因就是这行。

**正确做法**：APP 的设置一律存**宿主私有数据库**。

```js
// 存
await AiPhone.db.create("app_settings", {
  key: "theme", mode: "morandi", updatedAt: new Date().toISOString()
});

// 读
const rows = await AiPhone.db.list("app_settings", { limit: 20 });
const found = rows.find(r => r.key === "theme");

// 改（没有 upsert：先找到记录 id，再 update）
await AiPhone.db.update("app_settings", found.id, { mode: "macaron" });
```

需要 `app.data.read` / `app.data.write`。

### 坑 2 · 别把音频转成 base64 存进 db ★★

`callAudioRef` 是个**引用**（几十字节），不是音频本体。
自己实现时也别把音频 dataURL 塞进 `db.create`——db 记录是整体序列化的文本，
几 MB 的 base64 会让之后每次读写都重新序列化一遍，卡、费内存，iOS 上可能直接崩。

要存大文件，用 `AiPhone.media.put({ dataUrl })` 换 `media-store://` 引用，
db 里只存引用字符串（见官方 SDK 文档「媒体库：大文件的正确存法」）。

### 坑 3 · 富媒体消息没有可朗读内容 ★

`content` 是 `[图片] xxx`、`[表情] xxx` 这类占位文本的消息，即使有引用也别念。
播放前先剥掉占位前缀，空了就跳过。

```js
const text = String(m.content || "").replace(/^\[(图片|表情|红包|转账|语音)\]\s*/, "").trim();
if (!text) return;   // 没有可朗读的文字
```

### 坑 4 · 留档会被自动清理 ★

留档有保留策略（默认最近 30 天 / 最多 400 段，超出从最旧清）。
所以一条消息**曾经有** `callAudioRef`，过一阵可能就没了。

**不要在本地缓存「这条有原音」这个判断**——每次都从当前读到的消息里现取。
播放失败（引用已失效）时也要能**回退重新合成**，别只弹个错误。

---

## 七、验收清单

- [ ] 部署了留档改动的站点：新打通话 → APP 里能放**原音**（音色与通话时一致）
- [ ] 没部署的站点：**不报错**，退回重新合成，提示文案中性
- [ ] 老通话（无留档）：同样不报错、能回退
- [ ] 播放中点第二次能停止；切走页面能停
- [ ] 留档被清理后，播放失败能回退而不是卡住
- [ ] iOS 上播放正常，点锁屏媒体卡片不会白屏
- [ ] APP 的设置（主题等）退出重进还在（证明没用 `localStorage`）

---

## 八、『通话统计』APP 需要哪些仓库改动

上面讲的是通用做法。这一节把**真实用例**摊开——`通话统计` APP（id `call.stats`）
用到了哪些仓库能力、分别依赖哪处改动、缺了会怎样。

### 8.1 先说结论：大部分功能不依赖任何仓库改动

「通话统计」的核心是**统计**：总览图表、日历视图、明细列表、AI 总结、角色感受、八套配色。
这些全部基于 `chat.readHistory` 读到的消息，**任何版本的仓库都能用**。

真正依赖仓库改动的只有两件事：

| APP 里的功能 | 依赖的仓库改动 | 没有它会怎样 |
|---|---|---|
| **复听原音** | 通话语音留档（§二） | 退化为重新合成——音色语气可能不同 |
| **折叠条数/时长准确** | 折叠判定规则（§8.3） | 老通话显示成「0 条」、用户标的结尾不生效 |

### 8.2 依赖一：通话语音留档

**要的仓库改动**：

| 文件 | 改动 |
|---|---|
| `lib/call-audio-storage.ts` | **新增**。`persistCallAudio` 落库返回引用；保留策略 30 天 / 400 段 |
| `components/chat/voice-call-screen.tsx` | TTS 合成后落库，引用写进消息 |
| `components/chat/video-call-screen.tsx` | 同上 |
| `components/chat/group-call-screen.tsx` | 同上（逐条挂，各角色音色可能不同） |
| `lib/chat-storage.ts` | `ChatMessage.mediaData` 新增 `callAudioRef` 字段 |

**APP 侧读到的就是它**：

```js
// 消息上多出来的字段
mediaData: { callAudioRef: "media-store://mc_1759..." }
```

**两条既有通道让它零额外改动**（不用改宿主 API）：

1. `serializeChatMessage` 已整包透传 `mediaData` → `chat.readHistory` 直接读得到；
2. 宿主代播 `voice.play` 已支持 `media-store://` 引用 → 直接播。

**APP 侧必须配套的两件事**（否则体验会崩）：

- **中性文案**：不要写死「原音」，因为对方站点可能没部署（见 §五）；
- **回退重新合成**：读到无 `callAudioRef` 时用 `voice.tts` 兜底，不能只弹错误。

### 8.3 依赖二：折叠判定规则（影响统计准确性）

「通话统计」要**自己识别通话区间**（它不能直接调聊天室的折叠逻辑，是独立实现的），
所以判定规则必须和聊天室**保持一致**，否则同一通电话在聊天室和统计里数字对不上。

**要的仓库改动**：

| 能力 | 消息上的字段 | 作用 |
|---|---|---|
| 区分通话消息 | `origin: "call"` | 只收通话产生的，不收聊天室的 |
| 时长 | `mediaData.callDuration` | 挂断留痕上的时长文本（`"12:03"`） |
| 手动起点 | `mediaData.callStartMarker` | 起点留痕丢失时手工圈定 |
| 手动终点 | `mediaData.callEndMarker` | 用户标的结尾，**优先于挂断留痕** |

**判定规则（APP 侧要复刻的逻辑，与聊天室一致）**：

```
起点：系统留痕「发起了语音/视频通话」，或 callStartMarker
终点：callEndMarker 优先，否则挂断/拒绝/取消留痕；都没有则不折
成员：逐条判 —— origin === "call" 或 origin 不存在（老记录）都收
统计：条数与时长按全量算，不按加载窗口
```

> **最容易错的一条**：不要用「整段判定」。`origin` 是后加字段，老通话消息没有它。
> 整段判定会被一条新消息连坐，把几十条老对话全排除——APP 里就显示成「0 条消息」，
> 而聊天室里可能折得好好的（或反过来）。**两边必须用同一套逐条判定。**

### 8.4 按需要的部署档位

| 档位 | 部署什么 | APP 表现 |
|---|---|---|
| **零改动** | 什么都不改 | 统计图表/AI 总结/配色全可用；复听走重新合成；老通话可能显示 0 条 |
| **只修折叠** | 折叠判定那几处（`origin` 判定 + 手动标记） | 条数与时长准确；复听仍走重新合成 |
| **完整部署（推荐）** | 折叠判定 + 通话语音留档 | 全功能：原音复听 + 准确统计 |

三档**都不会让 APP 报错**——设计时就把降级路径铺好了。

### 8.5 一句话

> **统计类 APP 天生宽容：数据在聊天记录里，读得到就能用。
> 真正要仓库配合的只有两处——**声音要不要留**（决定能不能复听原音）、
> **边界怎么判**（决定统计数字准不准）。**

---

## 九、参考

- 留档功能的宿主侧实现与全部推导：`docs/call-feature-updates.md` §二、
  `docs/call-feature-porting-guide.md` 坑 22
- 通话折叠判定规则的完整推导：`docs/call-feature-updates.md` §二 A、
  `docs/call-feature-porting-guide.md` 坑 21
- 官方 SDK 文档：语音能力（`voice.play` / `voice.tts` / `voice.readProfiles`）、
  媒体库（`media.put` / `get` / `delete`）、聊天历史（`chat.readHistory`）
- 真实用例：「通话统计」APP（id `call.stats`）——优先原音、无则重合成；
  统计侧复刻了聊天室同一套折叠判定
