# 自部署 fork 相对官方上游的改动总台账

> 归属：个人自部署 fork（分支 `main`）
> 用途：自己留存 + 将来同步官方时判断冲突 + 给接手的人一条不走弯路的线索
> 生成方式：逐文件读源码实证为主，未读到的地方明确标注，绝不把推断写成事实

---

## 零、这份文档的实证等级

每一条改动末尾带一个标记，用来区分可信度：

- **【实证】**——本次或此前逐文件读过源码，行为、成因、文件名都核对过，可以照着改。
- **【半实证】**——读了主文件，但没有把整条调用链读完；方向可信，细节可能有偏。
- **【推断】**——只依据官方对比接口的 diff 统计和文件名判断；**框架和规模可信，细节未核实**。按它动手前请先读文件。

上一版 D / E / F 三节全是【推断】。这一版把能读的都读了，标记随之上调或保持诚实。

**2026-10-09 增量**：本次补入 C12–C16、B6–B8 与新铁律（通话折叠判定、语音留档、
离线推送修复、PWA 缓存），对应提交 4f3ba14 → 6d3b2a8。基线由「领先 149」
更新为「约 159」——**这个数受对比接口缓存影响，不必较真，要看实际差异用「对比官方版本」现查。**

---

## 一、基线现状

| 项目 | 数值 |
| --- | --- |
| 分支 | `main` |
| 相对官方 | 领先 **约 159** 个提交，落后 **3** 个提交 |
| 可贡献文件（官方白名单内） | 114 个 |
| 白名单外改动 | 22 个（`android-shell/` 整块 + 少量配置） |
| 壳版本 | `versionCode 8` / `versionName "1.0.9"` |

**关于「落后 3 个提交」**：这个数受 GitHub 对比接口缓存影响，可能不准。想跟官方对齐时用「同步官方更新」（无冲突一键完成，自己的 149 个提交原样保留）；有冲突它会被拒、fork 不动，再手工处理。

**关于对比列表里的 `+0/-0`**：`lib/shell-call-overlay.ts`、`lib/shell-notify.ts`、`lib/shell-detect.ts`、`lib/push-selfcheck.ts`、`styles/phone-shell.css` 等条目显示 `+0/-0`，但实际有实质改动——那是对比接口在文件数超限后没附 diff 统计。**不要拿这些数字当改动量的证据。**

---

## 二、模块台账

### A. 原生壳与状态栏（`android-shell/`）

> 白名单外，**不能**走官方贡献通道；同步官方时这块永远是自己改自己的，不会冲突（官方基本不动 `android-shell/`）。

#### A1. 全屏 WebView 状态栏高度注入 【实证】

- **文件**：`android-shell/.../MainActivity.kt`、`styles/phone-shell.css`
- **做了什么**：壳隐藏系统状态栏后，把状态栏/刘海高度换算成 CSS px，写进 `--android-shell-status-bar-height` 并派发 `floatshell-statusbarheight` 事件；网页层 `styles/phone-shell.css` 用 `--status-bar-drop` 消费。
- **为什么这么改**：壳隐藏了状态栏，网页却需要在刘海和状态栏区域留出安全区，两边的坐标系必须打通。
- **踩过的坑（关键）**：取 inset 必须用 `getInsetsIgnoringVisibility(statusBars()).top`。因为壳把状态栏隐藏了，`getInsets()` 对已隐藏的系统栏恒返回 0，写出来永远是 0px，界面看起来「没生效」。
- **症状**：状态栏高度变量恒为 0，顶部内容被刘海遮挡。

#### A2. 壳版本号约定 【实证】

- **文件**：`android-shell/app/build.gradle`、`MainActivity.kt` 的 `VERSION` 常量
- **铁律**：两处必须同步递增，否则覆盖安装装不上或版本显示不一致。
- 历史：`1.0.7` 回复条配色逐项自定义；`1.0.8` 浮窗自检与失败留痕 + 修 THEME_DEFAULT 编译错误；`1.0.9` 修浮窗头像撑爆 Binder（见 C 节）。

#### A3. 离线推送长连接 `PushService` 【实证】

- **文件**：`android-shell/.../PushService.kt`、`components/shell-push-registrar.tsx`、`lib/push-client.ts`、`lib/personal-push-cloud.ts`
- **做了什么**：壳内维持一条到自建 Supabase Realtime 的长连接，收到推送就发原生系统通知。**不依赖 Google 服务**，所以国行设备和没有 GMS 的环境也能用。
- **为什么不用 FCM**：目标用户大量在无法使用 Google 服务的环境。
- **坑**：网页侧注册失败时壳要有兜底再注册（`shell-push-registrar.tsx`），否则网页一次注册失败就彻底收不到离线消息。

#### A4. 原生通知桥 `AndroidShell.notify` 【实证】

- **文件**：`lib/shell-notify.ts`、`android-shell/.../MainActivity.kt`
- **做了什么**：网页调用 `notify` 弹原生通知，第 4 个参数传 `sessionId`，点通知直达对应会话；第 3 个参数传角色头像。
- **坑 1（兼容）**：`sessionId` 是多加的第 4 参数，**旧壳会忽略多余参数**——所以加参数不会让老版本炸，可以平滑升级。
- **坑 2（体积门控，重要）**：头像以 data URL 传，Base64 比原始字节大 1/3。快照有 900KB 上限，塞满头像会把整条消息撑爆导致 413 拒收——**整条离线消息都丢了**，不是只丢头像。所以加了 `NOTIFY_AVATAR_MAX_CHARS = 120000`：超限就只发通知不发头像。`lib/shell-notify.ts` 里另有 `MAX_AVATAR_URL_CHARS = 400000`。
- **症状**：偶发「离线消息丢失」，且只在头像大的角色上出现。

---

### B. 离线推送与主动消息

#### B1. 排期落盘即广播 【实证】

- **文件**：`lib/bailout-dirty.ts`
- **做了什么**：主动消息的排期一旦落盘，立刻广播 `ai-phone-bailout-dirty`，让推送侧马上挂单。
- **为什么**：不广播就得等下一次轮询，用户会感觉「排了但半天不来」。

#### B2. 撤销排期要通知服务端 【实证】

- **文件**：`lib/bailout-cancel.ts`
- **做了什么**：`emitBailoutCancel` 按 key 或 prefix 撤销；**本地删掉之后必须同时告诉服务端**。
- **踩过的坑**：只删本地不发撤销，服务端仍会照原排期推过来——用户删了消息却照收，像见鬼。

#### B3. 推送自检与诊断 【实证】

- **文件**：`lib/push-selfcheck.ts`、`lib/push-bailout-diagnostics.ts`、`lib/push-bailout-client.ts`
- **做了什么**：自检链路 + 诊断输出，把「为什么没收到推送」拆成可读的几段。
- **经验**：推送类问题链路长（网页排期 → 服务端 → 长连接 → 壳 → 系统通知），没有诊断就只能靠猜。

#### B4. 断线重连上限 【实证】

- **文件**：`lib/idle-reconnect-storage.ts`
- **做了什么**：`IDLE_RECONNECT_MAX_CONSECUTIVE = 3`，连续重连失败三次就停手，避免无限重连把设备和电量拖垮。

#### B6. 通话期间不挂 / 撤销离线预约 【实证】

- **文件**：`lib/push-bailout-client.ts`、三个通话屏
- **做了什么**：两半一起做——
  1. **挂载时撤销**：通话开始调 `suspendBailoutsForCall(sessionId)`，撤销该会话已挂的三类键
     （`followup:<sessionId>:` 追问兜底、`reply:<sessionId>` 回复兜底、`idle:<ruleId>:` 冷场重连）；
  2. **arm 时门控**：追问兜底、冷场重连在挂单前判 `isCallActiveForSession(sessionId)`，通话中不挂。
- **症状（修的就是它）**：明明在通话，却按沉默判定生成了一条主动消息，**只在系统通知里冒出来**，
  聊天室里没有对应记录。
- **设计取舍**：通话结束**不主动重挂**，靠下次用户消息或巡检自然重排。
  理由：通话何时结束不好判（挂断/崩溃/强杀都可能），主动补挂反而容易出错。

#### B7. 离线推送：点击直达会话 + 文案与聊天一致 【实证】

- **文件**：`lib/shell-notify.ts`、相关推送组装点
- **做了什么**：通知里的文案与聊天室实际内容统一；点通知能直接跳到对应会话。
- **配套**：`sessionId` 走的是「多加的第 4 个参数」，旧壳忽略多余参数不会炸（见 A4）。

#### B8. 离线推送：壳通知使用角色头像（大图标） 【实证】

- **文件**：`lib/shell-notify.ts`、`android-shell/.../MainActivity.kt`
- **做了什么**：原生通知的大图标改用角色头像，一眼能看出是谁来的消息。
- **注意体积门控**：头像以 data URL 传，快照有上限，超限就**只发通知不发头像**
  （`NOTIFY_AVATAR_MAX_CHARS = 120000`）——不门控会整条消息 413 拒收，丢的是整条离线消息（见 A4）。

#### B5. 离线来电能力注入 【实证】

- **文件**：`lib/builtin-preset.ts`、相关 prompt 注入点
- **做了什么**：注入 `CALL_INVITE_INSTRUCTION`，让角色具备「主动来电」能力（见 C9）。
- **频控**：`CALL_INVITE_WINDOW_MS = 20 * 60 * 60 * 1000`，同一角色约 20 小时最多来电一次。
- **为什么频控**：没有频控时角色会连着打，体验很糟。

---

### C. 通话（本 fork 最重的一块）

> 网页层在贡献白名单内（114 个文件里通话占二十多个）；**壳侧 `CallOverlayService.kt` / `CallControlService.kt` / `OverlayActionReceiver.kt` 在名单外**。移植只能靠 `docs/call-feature-porting-guide.md`。

#### C1. 通话逻辑全局化 【实证】

- **文件**：`lib/call-session-store.ts`（新增）、`components/chat/call-layer.tsx`（新增）、`components/desktop-shell.tsx`
- **做了什么**：通话状态从各通话屏内部提到全局 store——`startCall` / `minimizeCall` / `restoreCall` / `endCall` / `subscribeActiveCall` / `getActiveCall`。**store 只存身份（谁在通话），不存会话对象**；`call-layer.tsx` 由桌面壳常驻渲染（挂在 `<MascotPreviewHost />` 之后）。
- **为什么**：原来通话屏是某个聊天页的子组件，切页面通话就没了；提到桌面壳常驻才能「挂着小窗去别的 App」。
- **坑**：`useSyncExternalStore` 的 `getSnapshot` 必须返回稳定引用，否则每次渲染都当成变化，直通无限重渲染 + 界面卡死。

#### C2. 三端通话屏共用壳浮窗 【实证】

- **文件**：`lib/shell-call-overlay.ts`、`components/chat/use-shell-call-overlay.ts`、`voice-call-screen.tsx`、`video-call-screen.tsx`、`group-call-screen.tsx`
- **做了什么**：语音 / 视频 / 群聊三个通话屏统一走同一个 hook，把通话状态推给壳侧浮窗。
- **壳侧桥方法**：`startCallOverlay` / `updateCallOverlay` / `stopCallOverlay` / `getOverlayDebugInfo`。

#### C3. 忙时静默丢消息 → 排队补发 【实证】

- **文件**：`components/chat/use-call-reply-queue.ts`（新增）、三通话屏、`components/chat/call-mini-window.tsx`
- **根因**：通话屏接收逻辑是 `if (状态 === IDLE) runConversationTurn(text)`——角色说话或思考时进来的消息**被静默丢弃**；而浮窗回复条的发送键不看状态，永远可点。于是用户发出去、界面没反应，事后也没有任何提示 = 用户说的「空发」。
- **方案**：忙时排队、空闲自动补发。**上限 5 条**，超出拒收并保留输入内容不吞掉。
- **一次只补发一条**：发出去后状态转 PROCESSING，effect 重跑发现非 IDLE 自然停手——**不需要额外的锁**，这是让它不重复发送的关键设计。
- **挂断清空**队列。
- **可见性**：全屏界面顶部显示「对方说完就发 · 还有 N 条」；小窗左上角挂「待发 N」角标（`pendingCount` prop）。提交改为看返回值：队列满时保留输入、不收起回复条。
- **教训**：所有「忙时怎么办」的分支都必须显式设计。UI 可点但后端静默丢，是最难查的一类 bug。

#### C4. 浮窗回复条配色自定义 【实证】

- **文件**：`lib/call-overlay-theme.ts`、`components/settings/call-overlay-settings.tsx`
- **做了什么**：回复条配色逐项自定义；新增 `HexInput` 支持直接填色号（`#3B82F6` 与 `#RGB` 简写、`#` 可省；失焦或回车提交，非法输入退回原值；编辑期间不回写外部值，避免打断输入）。取色器保留，粗略挑色用。
- **壳侧坑**：`Color.parseColor` **不认** `#RRGGBBAA`（八位带透明度）格式，传进去直接抛异常。要做透明度请自己在 Kotlin 侧拆。

#### C5. 浮窗「又不行了」——头像撑爆 Binder 【实证 · 关键】

- **文件**：`android-shell/.../CallOverlayService.kt`、`MainActivity.kt`
- **诊断实锤**：`startForegroundService: RuntimeException: android.os.TransactionTooLargeException: data parcel size 5040676 bytes`。
- **根因**：角色头像以 data URL（Base64，比原始字节大 1/3）随 Intent 传给浮窗服务；**Binder 事务上限约 1MB**，几 MB 的头像直接超限抛异常，服务压根起不来。
- **为什么「时好时坏」**：头像小时能过、大时必炸。此前因此猜错两轮（先猜权限、再猜时序和生命周期，全错）。
- **修法**：
  - 新增 `prepareAvatarRef()`：内联头像先落成 `cacheDir/call_overlay_avatar.img`（固定文件名、每次覆盖），Intent 只带**文件路径**；http(s) 直链与已是路径的值原样返回。
  - `startCallOverlay` 与 `updateCallOverlay` **两条 Intent 路径都要改**——只修 start 会留同源坑，下次 update 时再炸一遍。
  - 新增 `decodeLocalAvatar()`：读本地文件时按需降采样（浮窗最宽 320dp，宽超过 1024 就 `inSampleSize` 倍增），仍兼容老的 data URL 路径。
- **通用铁律**：**大对象绝不进 Intent。** 这是 Android 的硬限制，不是偶发问题。

#### C6. 浮窗显隐改由 Activity 生命周期驱动 【实证】

- **做了什么**：`onStop` / `onStart` → `CallOverlayHostBackground` / `CallOverlayHostForeground`，不再依赖网页的 `visibilitychange`。
- **为什么**：App 退到后台后网页 JS 会被系统冻结，`visibilitychange` 不一定发得出来，浮窗就会「该出现时没出现、该消失时挂着」。由原生生命周期驱动才可靠。

#### C7. 浮窗自检与失败留痕 【实证 · 排障基础设施】

- **文件**：`CallOverlayService.kt`、`lib/shell-call-overlay.ts`、`components/settings/call-overlay-settings.tsx`
- **做了什么**：`debugInfo(context)` 一次输出六项：`canDraw` / `running` / `hasInstance` / `windowAdded` / `visible` / `hostInForeground`，外加 `lastError`。桥方法 `getOverlayDebugInfo()`；网页侧 `readShellOverlayDebugInfo()`；设置页「通话浮窗外观 → 诊断」展示六项并注明「哪一项为否对应什么问题」。
- **配套**：`start()` 不再吞异常（记录 `ForegroundServiceStartNotAllowedException` 等）；`addView` 失败同样记录原因并复位 `rootLayout = null`。
- **教训（最重要的一条）**：**整条链路 `runCatching` 静默吞异常 = 蒙眼改代码。** 前两轮全靠猜、全猜错，有了这六项 + `lastError` 一次定位。任何「理论上不该失败」的桥调用，都要留一条失败痕迹。

#### C8. 自动搭话 【实证】

- **文件**：`lib/call-auto-chat.ts`、`components/chat/use-call-auto-chat.ts`、`components/chat/call-auto-chat-control.tsx`
- **做了什么**：通话中角色可自动搭话（避免冷场），可在通话界面开关。

#### C9. 离线来电 【实证】

- **文件**：`lib/builtin-preset.ts` 注入的 `CALL_INVITE_INSTRUCTION`、`lib/call-session-store.ts`、桌面壳监听 `chat-call-ended`
- **做了什么**：角色可主动打来电话（走离线推送链路），通话结束后由桌面壳监听 `chat-call-ended` 事件触发角色回应。
- **频控**：同角色约 20 小时一次（见 B5）。

#### C10. Android 12+ 后台启动前台服务限制 【实证】

- **症状**：Android 12 及以上，App 在后台时 `startForegroundService` 抛 `ForegroundServiceStartNotAllowedException`，浮窗起不来。
- **处置**：把这条例外如实记进 `lastError`（见 C7），不要吞掉。真正要后台起服务需要 `SYSTEM_ALERT_WINDOW` 等条件配合，属于系统限制，不是代码 bug。

#### C12. 通话消息折叠（判定规则） 【实证 · 关键】

- **文件**：`components/chat/chat-room.tsx`（`voiceCallGroups` 一段，约 200 行）、`components/chat/voice-call-screen.tsx` 等三屏
- **做了什么**：把一通话的消息收成折叠条（「语音通话 · 全程 12:03 · 共 23 条」）。
  判定规则是这一块的全部难点，**错了就是用户实报的 bug**：
  - **来源逐条判，不整段判**：`origin === "call"` 或 `origin` 不存在（老记录）都收；
    只有明确是其它来源（chat/custom_app/reading_discuss…）才排除。
  - **起点**：系统留痕「发起了语音/视频通话」，或手动标记 `mediaData.callStartMarker`（右键菜单新增）。
  - **终点**：**手动标记 `callEndMarker` 优先**，挂断/拒绝/取消留痕只作候选。
  - **绝不按时间断层猜**：结束时刻只认上面两个明确来源，都没有就整段不折。
  - **全量预计算**：直接翻整个会话算区间，再映射回当前加载窗口（默认只加载最近 50 条，
    长通话的起点留痕早被挤出窗口）。
  - **分段补偿**：通话被聊天室消息切断会分成多段，每段都显示全程时长与总条数 + 「第 X/Y 段」；
    「无结束记录」只标最后一段。
- **两个实报 bug（都修了，记录备查）**：
  1. **聊天室消息被吞**：早期按时间区间无差别全收，通话期间在聊天室发的消息也被折进去。
  2. **老通话折成「共 0 条」**：`origin` 是后加字段，老消息没有它。**整段判定**下，
     区间里出现任意一条带标记的新消息就整段切严格模式，于是几十条老对话被连坐排除。
     **改成逐条判定后解决。**
- **顺带修的一个语义坑**：手动标记原先只当「挂断留痕不存在时的兜底」，
  于是用户标了也不生效（实报：标了结尾，折叠仍按那条挂了一夜的挂断记录折，时长 11:52）。
  **改为手动优先。**

#### C13. 通话语音留档（复听原音） 【实证 · 关键】

- **文件**：`lib/call-audio-storage.ts`（新增）、三个通话屏、`lib/chat-storage.ts`
- **做了什么**：TTS 合成后把音频落进媒体库（`storeMediaBlob`），返回 `media-store://` 引用，
  写进对应消息的 `mediaData.callAudioRef`。链路：
  - `serializeChatMessage` 整包透传 `mediaData` → **自定义 APP 从 `chat.readHistory` 直接能读到引用**；
  - 宿主代播 `voice.play` **已支持 `media-store://` 引用**（内部 `loadMediaBlob` 转 objectURL），
    且不校验引用归属 → APP 拿到引用就能放原音，**无需改宿主 API**。
- **修的问题**：原先音频只活在通话屏内存 Map 里（上限 20 段），挂断即失；
  「复听」只能重新合成——音色语气每次不同，还重复烧额度。
- **保留策略**：轻量索引 `ai_phone_call_audio_index_v1` 记 `{ref, createdAt}`，
  默认**保留 30 天 / 400 段**，超出从最旧清（连带 `deleteMediaRef`）。
- **善后**：编辑 / 删除 / 重新生成字幕时同步清留档并摘掉 `callAudioRef`——不然点开听到的是另一句话。
- **老记录降级**：无留档就回退重新合成，但 UI 要**说清这条是原音还是重合成**。
- **落库细节**：`updateChatMessage` 是**顶层浅合并**，改 `mediaData` 必须自己 `{...原值, 新字段}` 拼全，
  否则会把这个消息上原有的通话时长等字段抹掉。

#### C14. 三通话屏能力对齐（视频/群聊补字幕操作） 【实证】

- **文件**：`components/chat/video-call-screen.tsx`、`group-call-screen.tsx`、`call-subtitle-item.tsx`
- **做了什么**：视频通话补上**重听 / 编辑 / 删除 / 重新生成**（原先只有语音屏有）；
  三项都落到真实聊天记录（字幕带 `messageIds`），并作废该句音频缓存。
- **顺带修的**：视频屏 import 了 `useCallReplyQueue` 却从未调用，`replyQueue` 未定义，
  只要渲染到引用它的分支（缩成小窗、挂安卓壳浮窗）就抛 `ReferenceError` → **整个通话页白屏**。
- **群聊特别**：字幕结构里有多发言人，**`senderName` 必须保留**，不能照抄单聊的处理。

#### C15. 通话屏落库后广播消息更新 【实证】

- **文件**：三个通话屏
- **做了什么**：通话中落库的消息立即广播 `chat-messages-updated`。
- **为什么**：通话屏在聊天室之外（由 `CallLayer` 渲染），不广播的话消息要等挂断才出现在聊天室里，
  折叠条也一直不更新（实报：要挂掉才同步）。

#### C16. 缓存版本与服务端缓存头 【实证】

- **文件**：`public/sw.js`、`netlify.toml`
- **做了什么**：`CACHE_VERSION` `v12 → v13`（activate 时整批清旧缓存）；
  给 `/sw.js` 加 `Cache-Control: no-cache, no-store, must-revalidate`。
- **为什么两条都要**：只升版本号不够——浏览器里缓存的旧 `sw.js` 还在用旧逻辑；
  只加 no-cache 也不够——已注册的旧 SW 照样发缓存。
- **诊断法（最实用的一条）**：找一个**代码里改过的文案**去对，对不上就是旧包。
  真实案例：折叠条代码是「共3条」，用户看到「3条消息」→ 文案不符 → 锁定旧包，
  一步定位，比翻日志快得多。

#### C11. 权限三类区别 【实证】

- 普通权限（如网络）：Manifest 声明即可。
- 运行时权限（如通知）：需要弹系统对话框申请。
- **特殊权限（如 `SYSTEM_ALERT_WINDOW` 悬浮窗）：弹窗弹不出来，必须跳系统设置页让用户手工开。**
- **症状**：以为弹了个申请框就完事，实际上用户从没看到过那个框，权限永远是「否」。

---

### D. 故事模式（本轮重点实证补齐）

> 上一版整节是【推断】。本轮读了 `lib/story-storage.ts`（全 971 行）、`lib/story-parser.ts`（全 136 行）与 `story-pagination-manager.tsx`，结论如下。

#### D1. 剧情方案升格为「公用方案仓库」 【实证】

- **文件**：`lib/story-storage.ts`（`StorySchemeRepository` 一节）
- **做了什么**：文风 / 状态栏 / 小剧场 / 快捷输入四类方案**从每个角色的 `settings` 里搬出来**，统一存进 KV 的公用仓库（键 `ai_phone_story_scheme_repo_v1`）；角色侧只保留「启用哪一个」的 id（`activeProseStyleSchemeId` 等）。旧字段标了 `@deprecated` 但仍在类型里，用于兼容旧备份。
- **为什么**：原来方案挂在每个角色上，改一次文风要逐个角色改，也存不下「我怎么改都改不好」的复用需求。
- **迁移**：`migrateLegacyStorySchemeData()` 在水合时跑——按「内容完全相同 → 同一个方案」去重；id 被占但内容不同（角色改过同名方案）则另存新方案并重映射启用选择。**必须先 `await hydrateKvDb()` 再读仓库**，否则会把已有仓库误判为空、用默认值覆盖（代码里有注释点明）。
- **回退语义**：启用的方案被别的角色删掉（选择悬空）时，`resolveActiveStorySchemes` 回落首个方案，而不是静默失效。
- **广播**：`saveStorySchemeRepository` 落盘后派发 `story-scheme-repo-updated`，剧情页据此刷新。

#### D2. 解析器：折叠标签、摘要与正则的顺序 【实证】

- **文件**：`lib/story-parser.ts`（`STORY_PARSER_VERSION = 8`）
- **做了什么**：
  1. 提取摘要**之前**先剥掉折叠标签块，避免 `thinking` 里提到的 `<summary>` 被优先匹配到；**但摘要标签本身要跳过跳过**（`if (tag.toLowerCase() === effectiveSummaryTag) continue`）——否则摘要被剥掉，`recent_story`/记忆就断了。
  2. 跑输出正则**之前**先把折叠块换成占位符，避免 `thinking` 里的 `<content>` 被正则误伤；跑完再把推理类正则（`placement=6`）单独作用回折叠块内部。
  3. `story_status` 与 `story_theater` **始终**折成可展开块，即使用户改过高级折叠标签也不丢。
- **为什么**：这些都是「顺序错了就静默少东西」的坑——摘要丢了不报错，只是记忆慢慢变空。
- **症状对照**：记忆里看不到剧情事件 → 检查摘要标签是否被当折叠标签剥掉了。

#### D3. 会话 / 分线 / 多人组数据结构 【实证】

- **文件**：`lib/story-storage.ts`
- **做了这些规范化**：
  - 会话统一 `ownerType: "single" | "group"`，`ownerId` 缺省回落到 `characterId`；
  - 分线用 `branchId`（主线固定 `main`、`branchOrder 0`），同一 owner+branch 有重复时按「活动时间 → updatedAt → id」选**优先**那条并丢弃其余（`normalizeStorySessions`）；
  - 多人组存 KV（`ai_phone_story_groups_v1`），消息仍按 `StorySession` 分会话存；组至少 2 人（`createStoryGroup` 少于两人直接抛错）；
  - 分线可设 `inheritRecentMemory`（是否读创建前的最近记忆）与 `independentStory`（不读任何记忆）；这两个在创建后由 UI 锁定，避免语义被反复改；
  - 折叠/排除标签默认值：`foldTags: "think,thinking,story_status,story_theater"`、`contextExcludedTags: "think,thinking,story_theater"`（**小剧场默认不进上下文**，摘要类则进）。
- **存储**：Dexie 库 `AiPhoneStoryDB`，version(1)，表 `sessions(id, characterId, updatedAt)` 与 `messages(id, sessionId, createdAt)`；内存缓存 + 异步落盘，读接口不返回 Promise。
- **坑**：`loadStorySessions()` 排序用 `(b.updatedAt || "")` 兜空——旧版本/异常导入可能缺 `updatedAt`，不兜的话排序直接让页面崩。

#### D4. 分页管理器与多人组 UI 【实证】

- **文件**：`components/story/story-pagination-manager.tsx`（+387 行新增）
- **做了什么**：剧情目录页（分线列表）、多人组的新建/改名/删除、分线新建/删除、导出单个会话/导出全部；`AvatarCollage` 支持多人组头像拼图（最多 4 人）与自定义剧情头像。
- **分线创建入参**：`{ name, inheritRecentMemory, independentStory }`。

#### D5. 剧情设置页独立成页 【半实证】

- **文件**：`components/story/story-settings-page.tsx`（+735 行新增）、`components/story/story-app-base.tsx`（+1210/-150，全 fork 最大单片改动）
- **判断**：设置从内容页里拆出来单独成页，`story-app-base` 是承载大改的主体。**本轮没有逐行读这两个文件**，行数可信、具体结构未核实——按它改之前先读。

#### D6. 滚动修复与自动阅读 【半实证】

- **文件**：`components/story/story-scroll-fix.tsx`（+25 新增）、`components/ui/story-html-renderer.tsx`（+209/-12）、配套 `autoReadingEnabled` / `autoReadingSpeed`（像素/秒）两个 `uiPrefs`
- **判断**：新增了两块修复组件，自动阅读通过滚动速度控制。细节未逐行核。

#### D7. 剧情输出不进 / 进记忆的边界 【实证】

- **文件**：`lib/story-storage.ts` 的 `loadStoryProjectionEntries`
- **规则**：只有带 `storySummary` 的 assistant 消息才会成为记忆投影，文本压成纯文本并截到 500 字；`independentStory` 的会话**必须** `includedInMemoryAt` 才计入（独立剧情默认不进）。
- **为什么记这条**：排查「剧情怎么没进记忆」时，先看这三条门槛，别一上来就怀疑模型。

---

### E. 聊天增强

#### E1. 聊天记录导出 / 导入（修「导入后数据被清空」） 【实证 · 关键】

- **文件**：`lib/chat-record-transfer.ts`（+191 新增）
- **做了什么**：导出单个会话为 `float-chat-records` v1 JSON，**内嵌媒体**（media-store blob 转 data URL、image-asset 从 IndexedDB 取）；导入时把媒体重新落库、旧引用换新引用、消息 id 加目标会话前缀去重。
- **修的那个大坑（原话记在代码注释里）**：旧实现逐条 upsert，**每条消息都会触发一次全量会话预览重算、并对 sessions 表排队一次 `clear+bulkPut`**。几千条记录就会冻结主线程、堆出上千个清表事务——**这就是用户实报的「导入后数据被清空、小手机变回初始状态」**。
- **修法**：先在内存里一次性改写全部字段（媒体引用、消息 ID、目标会话、顺序号），再交给 `bulkUpsertImportedMessages` 批量落库。
- **另一条纪律**：落库失败**必须如实抛出**（批量写入按块提交，重试时已写入部分会自动去重跳过），绝不吞错误让用户以为导入成功、重启后数据消失。
- **上限**：超过 100000 条直接拒绝，要求拆分。
- **教训**：**批量导入永远不要走逐条「全量重算」路径。**

#### E2. 聊天语音音效 【半实证】

- **文件**：`lib/chat-sound.ts`（+235 新增）、`components/chat/chat-sound-editor.tsx`（+97 新增）、`components/chat/session-chat-sounds.tsx`（+198 新增）
- **判断**：新增了一套按会话可编辑的聊天音效（消息来/去等触发点）。三个文件都是新增，方向可信；**细节未逐行核**。

#### E3. 全局聊天信息设置 【半实证】

- **文件**：`components/chat/global-chat-info-settings.tsx`（+403 新增）、相关分支 `feat/global-chat-info-20260909`
- **判断**：把聊天信息（头像/昵称等展示项）做成全局设置页。细节未核。

#### E4. 用户头像统一 【半实证】

- **文件**：`lib/user-avatar-image.ts`（+24 新增，**已读全**）、`components/chat/user-profile-panel.tsx`（+68/-4）
- **实证部分**：`fileToUserAvatarDataUrl(file, maxSize=640, quality=0.86)` 用 canvas 等比缩放后 `toDataURL("image/webp", 0.86)`——**统一压成 webp 再存**，控制本地体积。
- **判断**：同一份压缩逻辑被全局聊天的用户头像复用（对应分支 `feat/unified-user-avatar-global-chat-20260909`）。

#### E5. 消息气泡与状态区 【半实证】

- **文件**：`components/chat/message-bubble.tsx`（+66/-2）、`components/chat/custom-status-frame.tsx`（+42/-13）、`lib/chat-status-region.ts`（+30/-2）
- **判断**：气泡新增了渲染能力，自定义状态区有调整。细节未核。

---

### F. 杂项

#### F1. 数据备份 / 恢复的健壮化 【实证 · 关键】

- **文件**：`lib/data-management/idb.ts`（777 行，全读）
- **修的四类问题，每类都对应一个真实故障**：
  1. **打不开库不再当空库**：导出时 `openDb` 失败会返回带 `error` 的空 stores——如果不带错误，会打出一份「看起来成功、实际缺整库」的备份。注释里写明是用户实报踩坑。
  2. **KV 读不到必须失败**：`readKvRecords` 明确拒绝退回内存缓存并抛错中止——水合失败时缓存可能是空的/不完整的，退回缓存 = 产出看似正常的残缺 ZIP，用户换设备导入后才发现历史没了。
  3. **逐条兜底**：KV / localStorage 导入从「整个循环一个 try」改成**每条一个 try**。旧写法第一条出错后剩余记录全部静默丢弃，正是「恢复内容不全」的来源之一。
  4. **IndexedDB 建库只提一次版本**：`ensureStores` 把所有需要的 store 在**一次版本提升**里建完。旧写法每个 store 各提一次版本，会把新恢复的库版本推得远高于 App 自己打开的版本，直接 `lower version than existing` 失败。
- **两个超时设计**：
  - `blocked ≠ 失败`：持有旧连接的页面随时可能松手（Dexie 收到 versionchange 会自动关），所以给**宽限窗口**（`blockedGraceMs`，建库时 15s），等不到才放弃。立刻放弃会让「App 自己开着库」这种最常见场景整库导入失败。
  - **总体超时兜底**：排在 blocked 升级请求后面的 open **不会收到任何事件、只会无限挂起**，所以必须有 `deadlineMs`（回退 open 用 3s）；迟到的连接由 `settle` 关掉防泄漏。
- **内存策略**：导出游标先排空（IDB 事务里不能 await），排空后逐条序列化并**原地置空**原始记录引用——大库导出时这份多余拷贝就是压垮移动端的最后一根稻草。
- **索引备份**：备份里连索引定义一起带（`StoreIndexBackup`），恢复时补建，否则恢复到「App 从没建过 schema」的浏览器里，索引查询直接 `SchemaError`。
- **已知专用修补**：记忆库 `ai_phone_memory_db_v1/memories` 的三个索引（`by_character` / `by_character_type` / `by_character_created`）会在恢复时按需补建；只在索引真缺时才提版本，避免被正在开着的记忆页连接挡住。
- **可选裁剪**：`filterOldDynamicImages` 按时间阈值裁掉旧动态图（只影响备份，不动实时数据）；头像与桌面/主题素材**故意不裁**。

#### F2. 主题预设 【实证】

- **文件**：`lib/theme-preset-storage.ts`（+207 新增）、`components/phone-theme-app.tsx`（+251/-8）、`components/desktop-customizer.tsx`（+40）
- **做了什么**：整机主题快照（`themeProfile` + 图标布局 + 小组件 + dock + 文件夹）存成命名预设，**上限 20 个**（超出抛错提示先删）；同名预设按名称（不区分大小写）覆盖；KV 键 `ai_phone_theme_presets_v1`。
- **设计取舍**：预设**只记录当前选中的那一张壁纸**（`wallpaperLibrary` 只放一个 `wallpaperAssetId`）——壁纸库是跨预设共享的用户素材库。
- **引用计数**：`themePresetUsesAsset(assetId)` 供删除素材前检查是否被预设引用。
- **清洗**：`normalizePreset` 会过滤掉越界/非法小组件（尺寸不在枚举、行列越界、页码非正整数都丢），坏数据不会让主题页崩。

#### F3. 生图 API 全局绑定 【实证】

- **文件**：`lib/image-generation-binding.ts`（+89 新增）、相关分支 `codex/global-app-api-bindings`
- **做了什么**：给生图方案一套**统一绑定 id**，跨全局共享：OpenAI 用 `openai:<presetId>`、NovelAI 用 `novelai:<presetId>` 前缀编码。`applyImageGenerationBinding(settings, bindingId)` 把绑定还原成实际配置（provider / apiKey / baseUrl / model …）。
- **容错**：绑定指向已被删的方案时不改配置原样返回（`if (!preset) return settings`）；当前 provider 是 NovelAI 时优先返回 NovelAI 的绑定。
- **为什么**：多个 App / 全局设置要引用「用哪套生图配置」，直接存 id 比存一份配置副本好维护。

#### F4. 自定义 APP 宿主 API 【半实证】

- **文件**：`lib/custom-app-host-api.ts`（2470 行，本轮只读前 80 行）、`lib/custom-app-registration.ts`、`lib/custom-app-types.ts`
- **已核实的部分**：宿主 API 把聊天、群聊、日历、记忆、世界书、语音（TTS/STT）、生图、钱包、主题素材、桥接外发等能力统一暴露给自定义 APP；改动包含权限（`CustomAppPermission`）、提示档案（`CustomAppPromptProfile`）等。
- **未核实**：具体新增了哪些 API 方法、权限模型怎么变——**文件太大没有全读，按它改之前务必读**。

#### F5. 渲染与样式 【推断】

- `styles/chat.css`、`styles/components.css`、`styles/phone-shell.css`、`styles/story.css` 都有改动（对比接口这几条显示 `+0/-0`，实际非零）。
- **未读**，需要时再核。

---

## 三、冲突风险清单（同步官方时重点看这里）

按「同步官方时会不会打起来」排序。

### 高风险：官方很可能也在改的文件

| 文件 | 本 fork 改动量 | 为什么高风险 |
| --- | --- | --- |
| `components/story/story-app-base.tsx` | +1210/-150 | 全 fork 最大单片改动，剧情是官方也在迭代的模块；冲突面最大 |
| `components/chat/chat-room.tsx` | 约 +290/-106 | 聊天主界面，双方都会动；**通话折叠一整块（约 200 行）也在这里**，是最容易打起来的地方 |
| `lib/chat-storage.ts` | 约 +390/-16 | 数据层，改动会牵动所有聊天功能；本轮又加了 `callAudioRef` / `callStartMarker` 两个 mediaData 字段 |
| `components/chat/voice-call-screen.tsx` / `video-call-screen.tsx` / `group-call-screen.tsx` | 各数百行 | 通话屏本身官方也在迭代；本轮三屏都动了（落库、字幕操作、推送撤销），冲突面变大 |
| `components/settings/image-generation-settings.tsx` | +387/-84 | 设置页大改，官方也在动生图 |
| `components/chat/chat-settings-panel.tsx` | +409/-19 | 同上 |
| `lib/checkphone-engine.ts` | +209/-4 | 查手机玩法 |
| `components/desktop-shell.tsx` | +168/-7 | 桌面壳，`<CallLayer />` 就挂在这里 |
| `lib/mascot-tools.ts` | +542/-2 | 小卷工具集，官方也在扩 |

### 低风险：本 fork 新建的文件（官方没有 = 不会冲突）

新增文件在同步时基本不会冲突，因为官方没有同名文件。这批包括：

- 通话：`lib/call-session-store.ts`、`lib/call-overlay-theme.ts`、`lib/call-auto-chat.ts`、`lib/shell-call-overlay.ts`、`lib/chat-avatar-intent.ts`、`lib/call-audio-storage.ts`、`components/chat/call-layer.tsx`、`call-mini-window.tsx`、`use-shell-call-overlay.ts`、`use-call-reply-queue.ts`、`use-call-auto-chat.ts`、`call-auto-chat-control.tsx`、`call-subtitle-item.tsx`、`components/settings/call-overlay-settings.tsx`
- 推送：`lib/bailout-dirty.ts`、`lib/bailout-cancel.ts`、`lib/push-bailout-diagnostics.ts`、`lib/push-selfcheck.ts`、`components/shell-push-registrar.tsx`
- 故事：`components/story/story-pagination-manager.tsx`、`story-settings-page.tsx`、`story-scroll-fix.tsx`
- 音效：`lib/chat-sound.ts`、`components/chat/chat-sound-editor.tsx`、`session-chat-sounds.tsx`
- 其他：`lib/chat-record-transfer.ts`、`lib/image-generation-binding.ts`、`lib/user-avatar-image.ts`、`lib/theme-preset-storage.ts`、`lib/mascot-feature-knowledge.ts`、`components/chat/global-chat-info-settings.tsx`

> 但注意：**新增文件如果改了共享文件的调用点，冲突仍会出现在那些调用点上。** 比如 `use-call-reply-queue.ts` 是新文件，但三通话屏（官方也有）里的接入点是冲突面。

### 零风险：白名单外

`android-shell/` 整块（8 个文件）+ 少量配置。官方基本不动，同步时不会冲突，但也**不能贡献回去**。

### 同步操作建议

1. 先用「同步官方更新」试一键（无冲突时自己的 149 个提交原样保留）。
2. 被拒（有冲突）时**不用慌，fork 没有被改动**——GitHub 只在能干净合并时才动手。
3. 手工解冲突优先级：**上表「高风险」那 8 个文件先看**；低风险新增文件基本不用管。
4. 壳侧冲突概率极低，出问题多半是自己改漏了 versionCode。

---

## 四、铁律与教训（跨模块，最值钱的一节）

### 原生壳

1. **大对象绝不进 Intent。** Binder 事务上限约 1MB，头像 Base64 这种几 MB 的东西必炸。传路径，别传内容。（C5）
2. **同一个坑要一次修完。** `startCallOverlay` 和 `updateCallOverlay` 是两条 Intent 路径，只修一条 = 留一颗定时炸弹。（C5）
3. **特殊权限必须跳系统设置。** `SYSTEM_ALERT_WINDOW` 弹不出对话框，只能引导用户手开。（C11）
4. **取已隐藏系统栏的 inset 要用 `getInsetsIgnoringVisibility`。** 用 `getInsets()` 恒为 0。（A1）
5. **versionCode 和 VERSION 常量必须同步递增。**（A2）
6. **兼容旧壳靠「多传参数」。** 旧壳忽略多余参数，不会炸——加参数是安全的升级路径。（A4）
7. **显隐逻辑不要依赖网页 JS。** App 后台 JS 会被冻结，必须由原生生命周期驱动。（C6）

### 排障方法论

8. **静默吞异常 = 蒙眼改代码。** 这是这个 fork 交过最贵的学费：浮窗问题靠猜错了整整两轮（权限、时序、生命周期全猜错），加了六项自检 + `lastError` 后一次定位。**任何桥调用都要留失败痕迹。**（C7）
9. **加自检面板，别加猜测。** 状态可枚举时就把每一项都暴露出来，并注明「哪一项为否意味着什么」。（C7）
10. **让用户贴完整日志（`e:` 开头的行）**，不要零散报错——零散信息会诱导你往错误方向猜。

### 网页层

11. **忙时分支必须显式设计。** UI 可点、后端静默丢，是最难查的一类 bug。（C3）
12. **批量导入不要走逐条「全量重算」路径。** 每条触发全量预览重算 + 排队清表 = 导入后数据被清空。（E1）
13. **落库失败必须抛出。** 吞错误让用户以为成功、重启后数据消失，比直接报错恶劣得多。（E1）
14. **`useSyncExternalStore` 的 `getSnapshot` 必须返回稳定引用。** 否则无限重渲染。（C1）
15. **顺序敏感的解析必须写清顺序。** 摘要先剥折叠块但要跳过摘要标签本身；正则在占位符外跑。（D2）
16. **能推理顺序的问题，靠猜一定错。** 同上第 8 条。

### 数据与存储

17. **`blocked ≠ 失败`。** IDB 升级被占时要给宽限窗口，立刻放弃会让最常见场景（App 自己开着库）整库导入失败。（F1）
18. **建库只提一次版本。** 每个 store 各提一次会把版本推过 App 自己的版本，直接打不开。（F1）
19. **读不到真实存储时必须失败，绝不退回内存缓存。** 否则产出「看起来成功」的残缺备份。（F1）
20. **空值要兜。** 旧数据可能缺字段，排序里一个 `|| ""` 就能避免整个页面崩。（D3）

### 通话记录（本轮新增）

25. **边界判定要逐条，不要整段。** 一条新数据能让「整段判定」把几十条老数据连坐——
    实报就是老通话折成「共 0 条」。（C12）
26. **人工标记优先于自动留痕。** 用户亲手标的是明确意图，自动写的那条可能是误留的
    （挂了一夜忘了挂）。当「兜底」用就是标了也不生效。（C12）
27. **合成出来的东西要落库，别只放内存。** 内存缓存挂断即失，「事后想再听」就只能重算——
    既不一致又重复烧额度。（C13）
28. **改 `mediaData` 要自己拼全。** `updateChatMessage` 是顶层浅合并，直接传 `{newField}`
    会把这条消息上原有的字段（通话时长等）抹掉。（C13）
29. **删/改内容时要连带清掉它的派生物。** 文字改了，原音就对不上了——留着点开是另一句话。（C13）

### 发版与缓存（本轮新增）

30. **升级 SW 要两条一起做**：升 `CACHE_VERSION` + 给 `sw.js` 加 no-cache。
    只做一条，旧包照样在用户机器上跑。（C16）
31. **判断用户跑的是不是旧包，先对文案。** 找一处代码里改过的文案去对，
    对不上就是旧包——比翻任何日志都快。（C16）

### 数据安全约定

32. **不向官方贡献 PR**（用户已明确）。改动只留在 fork。
33. **壳侧永不在白名单内**，想复用只能照移植说明书手改。

### 工作流（血泪）

34. **一次只提交一份文档，确认落地再提下一份。**（见第五节事故记录）
35. **提交前先看远端 main 在哪。** 基点落后就会 `not a fast forward`（422）。

---

## 五、事故记录（务必保留）

### 事故 1：连续提交两份文档，第二份丢失

- **经过**：先提交 `docs/call-feature-porting-guide.md` 成功 → 远端 `main` 前进了一次；紧接着提交 `docs/fork-changes-overview.md`，但该提交基于更早的基点。
- **结果**：GitHub 返回 `422 Update is not a fast forward`。推送被拒，**暂存区同时被清空**，远端也没有该文件 → 第二份文档两头落空，只能重写。
- **根因**：提交基点过期（非快进）+ 失败时暂存清空，两个条件叠加造成丢失。
- **教训**：
  1. 一次只提一份，确认远端有了再提下一份；
  2. 提交前先确认远端 `main` 的位置；
  3. 大文档在本地也留一份（本次靠会话记忆重写，成本高）。
- **代码无任何损失**——丢的只是这份文档本身。

---

## 六、功能 × 文件快速索引

| 想改什么 | 先看哪个文件 |
| --- | --- |
| 通话状态、挂断、小窗 | `lib/call-session-store.ts`、`components/chat/call-layer.tsx` |
| 通话屏与壳浮窗桥接 | `components/chat/use-shell-call-overlay.ts`、`lib/shell-call-overlay.ts` |
| 通话忙时收消息 | `components/chat/use-call-reply-queue.ts` |
| 浮窗外观/配色/诊断 | `components/settings/call-overlay-settings.tsx`、`lib/call-overlay-theme.ts` |
| 浮窗起不来 | 先看设置页「诊断」六项 + `lastError`，再看 `CallOverlayService.kt` |
| 通话自动搭话 | `lib/call-auto-chat.ts`、`components/chat/use-call-auto-chat.ts` |
| 通话折叠折错（吞聊天室消息／共0条） | `components/chat/chat-room.tsx` 的 `voiceCallGroups`（判定规则见 C12） |
| 通话复听只能重新合成 | `lib/call-audio-storage.ts` + 三通话屏的落库点（C13） |
| 通话字幕重听/编辑/删除 | `components/chat/call-subtitle-item.tsx` + 三通话屏（C14） |
| 修复上线了但用户行为照旧 | `public/sw.js` 的 `CACHE_VERSION` + `netlify.toml`（C16） |
| 通话中弹出主动消息通知 | `lib/push-bailout-client.ts`（B6） |
| 离线推送不住 | `lib/push-selfcheck.ts`、`lib/push-bailout-diagnostics.ts`、`PushService.kt` |
| 排期删不掉 | `lib/bailout-cancel.ts` |
| 通知点击不跳会话 | `lib/shell-notify.ts`（第 4 参数 sessionId） |
| 状态栏高度不对 | `MainActivity.kt` 的 inset 取法 + `styles/phone-shell.css` |
| 剧情方案（文风/状态栏/小剧场） | `lib/story-storage.ts` 的 `StorySchemeRepository` |
| 剧情摘要/记忆断了 | `lib/story-parser.ts` 的折叠标签顺序 |
| 剧情分线/多人组 | `lib/story-storage.ts`、`components/story/story-pagination-manager.tsx` |
| 剧情设置页 | `components/story/story-settings-page.tsx` |
| 聊天记录导入炸档 | `lib/chat-record-transfer.ts`（别退回逐条 upsert） |
| 备份恢复不全 | `lib/data-management/idb.ts` |
| 主题预设 | `lib/theme-preset-storage.ts` |
| 生图配置引用 | `lib/image-generation-binding.ts` |
| 自定义 APP 宿主能力 | `lib/custom-app-host-api.ts`（2470 行，改前必读） |
| 用户头像压缩 | `lib/user-avatar-image.ts` |
| 壳版本 | `android-shell/app/build.gradle` + `MainActivity.kt` |

---

## 七、本版的诚实局限

**【实证】的部分**：A、C、D1–D4、D7、E1、E4（压缩逻辑）、F1、F2、F3。这些是逐文件读过源码写的，可以照着改。

**【半实证】的部分**：D5（剧情设置页与 `story-app-base`）、D6（滚动修复）、E2（音效）、E3（全局聊天信息）、E5（气泡与状态区）、F4（宿主 API）。主文件读到了或方向明确，但没有把整条链条读完。

**【推断】的部分**：F5（样式文件）。没读，需要时再核。

**完全没覆盖的**：`AndroidManifest.xml` 的权限声明细节、`PushService.kt` 的完整实现、`CallControlService.kt` / `OverlayActionReceiver.kt` 的作用、`lib/mascot-tools.ts` 新增了哪些工具、`hooks` 目录下的改动。用到时读文件，别拿这份文档当唯一依据。

**还要重申一句**：本文档描述的是**已经提交在 `main` 上**的改动。任何尚未提交的实验性改动不在此列。

