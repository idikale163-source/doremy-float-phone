// 小卷的本机功能知识库。
// 与聊天记录分库保存，避免清空小卷会话时把功能认知一并删掉；代码升级后按 revision
// 自动刷新内置条目。即使 IndexedDB 不可用，也会回退到同一份内置知识。

const MASCOT_KNOWLEDGE_DB_NAME = "AiPhoneMascotKnowledgeDB";
const MASCOT_KNOWLEDGE_DB_VERSION = 1;
const MASCOT_KNOWLEDGE_STORE = "knowledge";
const OWNER_FEATURES_KEY = "owner-custom-features";

export type MascotFeatureKnowledgeEntry = {
    id: string;
    title: string;
    location: string;
    facts: string[];
};

type MascotFeatureKnowledgeRecord = {
    key: string;
    revision: string;
    updatedAt: string;
    entries: MascotFeatureKnowledgeEntry[];
};

const OWNER_FEATURES: MascotFeatureKnowledgeRecord = {
    key: OWNER_FEATURES_KEY,
    revision: "2026-09-22.1",
    updatedAt: "2026-09-22T00:00:00.000Z",
    entries: [
        {
            id: "theme-presets",
            title: "主题预设",
            location: "主题 App → 主题预设",
            facts: [
                "可以保存当前主题为预设、切换预设和删除预设。",
                "主题预设保存当前外观配置；壁纸素材库仍由用户本机统一管理。",
            ],
        },
        {
            id: "api-bindings",
            title: "全局与 APP 配置绑定",
            location: "设置 → 配置绑定 → 全局APP绑定，或角色绑定 → APP",
            facts: [
                "调用优先级固定为：角色绑定 ＞ APP绑定 ＞ 全局绑定。",
                "APP 详情只设置文本与生图绑定，不显示语音绑定；语音仍走角色或全局配置。",
            ],
        },
        {
            id: "image-generation-character-identity",
            title: "生图 API 预设与角色形象锁定",
            location: "设置 → 图像生成 API",
            facts: [
                "OpenAI 兼容配置可保存、切换和删除预设。",
                "每个角色可单独填写人物特征提示词、上传参考图，并移动方框选取脸部区域。",
                "参考图可关闭但保留；默认开启“非自拍照不使用参考图”。NovelAI 会读取人物特征提示词，但不使用参考图。",
            ],
        },
        {
            id: "checkphone-batch",
            title: "查手机批量生成与新内容提醒",
            location: "查手机 → 右上角批量生成",
            facts: [
                "一次可选择 1 到 4 个 APP，只调用一次文本 API，并把结果分别保存到对应 APP。",
                "本轮生成出新内容的 APP 图标右上角会显示红点，进入该 APP 后清除。",
            ],
        },
        {
            id: "chat-transfer",
            title: "单个会话聊天记录导入导出",
            location: "私聊 → 右上角聊天信息 → 导出聊天记录 / 导入聊天记录",
            facts: [
                "可以把当前私聊记录导出成文件，也可以把兼容文件导回当前会话。",
                "这是会话级迁移，不等同于设置里的整机备份。",
            ],
        },
        {
            id: "profile-avatar",
            title: "用户资料头像",
            location: "聊天 → 我的 → 点击主页头像，或设置 → 用户信息",
            facts: [
                "点击“我的”主页头像可以快速从相册更换用户资料头像；用户信息编辑页仍然可以更换头像。",
                "主页头像、消息列表上方头像和朋友圈中的用户头像共用同一份资料，会一起更新。",
                "聊天气泡内的用户头像是另一套系统，可由单独会话头像或全局聊天头像覆盖，不会反向修改用户资料头像。",
            ],
        },
        {
            id: "chat-avatars",
            title: "私聊双方头像与角色自主换头像",
            location: "私聊 → 右上角聊天信息 → 设置头像",
            facts: [
                "用户可以分别直接更换“我的头像”和对方角色头像；“我的头像”只属于当前私聊，不会修改主页资料、会话列表上方头像或其他私聊。",
                "“我更换头像后希望对方做出反应”默认开启；开启时只向角色写入“用户名字更新了头像”这一句系统事件，关闭后不通知对方。",
                "用户也可以在私聊发送一张真实相册图片，并直接或暗示对方换头像；角色按人设自主接受或拒绝，接受后系统自动把该图片设为角色头像。",
                "自动换头像必须有实际图片文件；只有文字描述的“照片”卡片没有图片像素，不能作为头像。",
            ],
        },
        {
            id: "global-chat-info",
            title: "全局聊天信息",
            location: "聊天 → 我的 → 离线推送与定时消息下方 → 全局聊天信息",
            facts: [
                "用户头像、聊天背景、聊天室 CSS 与传入最近图片数量对私聊和群聊通用；全局状态栏只对私聊生效。",
                "优先级为：单独会话设置 ＞ 全局聊天信息；CSS 额外遵循：单独会话 CSS ＞ 全局聊天室 CSS ＞ 主页外观 CSS。",
                "全局状态栏和全局聊天室 CSS 可以从与单独会话相同的资源方案中导入。",
                "「聊天室自定义 CSS 样式」下方有「全部角色恢复默认」：一键清空所有私聊和群聊的单独 CSS（会先确认并显示数量），全部回落到全局聊天室 CSS；正在打开的聊天室会立即生效。",
            ],
        },
        {
            id: "chat-sounds",
            title: "聊天提示音",
            location: "聊天 → 我的 → 全局聊天信息 → 提示音；私聊 → 右上角聊天信息 → 角色专属提示音",
            facts: [
                "有 5 种提示音：新消息音效、发送消息音效、来电音效、致电音效、挂断音效；每种开启后会展开音频来源设置，可上传音频文件（存本机，8MB 以内）或填音频 URL，并可试听和清除。",
                "新消息音效配置音频后可点「测试弹窗」：模拟一条真实新消息，弹出桌面通知横幅并播放音效；全局页用最近活跃的会话来演示，角色专属页直接模拟该角色发来的消息。",
                "私聊聊天信息里有「角色专属提示音」：每种音效可选“跟随全局 / 专属 / 关闭”三档，专属档给该角色单独配音频，优先于全局聊天信息；专属开启但没配音频时沿用全局音频，关闭档则该角色不播这个音。",
                "来电音效在来电等待接听时循环播放（桌面来电横幅和通话屏都会响）；致电音效在呼叫等待接通时循环；挂断音效在通话结束、挂断或拒接时播放一次。",
                "新消息音效有两个子开关：“实时聊天不通知”（正打开该聊天时角色新消息不响）和“多条消息只通知1次”（同一角色连续多条消息 10 秒内只响一次）；专属档里未单独设置的子开关继承全局。",
                "提示音对私聊和群聊通用（角色专属目前只在私聊设置）；通话产生的系统消息（如“发起了语音通话”）不会触发新消息音效。",
            ],
        },
        {
            id: "chat-unread",
            title: "私聊未读红点",
            location: "聊天会话列表",
            facts: [
                "角色产生新消息且对应会话不在前台时，会累加未读数量并显示红点；进入会话后标记已读。",
                "未读红点只出现在聊天 App 的会话列表里；桌面聊天图标右上角不显示未读红点，这是用户刻意的选择，不要建议加回。",
            ],
        },
        {
            id: "story-tail-schemes",
            title: "剧情尾部方案（状态栏方案与小剧场方案）",
            location: "剧情 App → 右上角设置 → 剧情尾部",
            facts: [
                "每个角色可保存多套「状态栏方案」和「小剧场方案」，各自由 输出契约 + HTML 渲染 + 示例数据 组成，随时切换当前启用的一套。",
                "方案编辑器里可以导入导出：导出把该类型的全部方案存成一个 JSON 文件；导入支持导出文件、方案数组或单个方案对象，方案会追加进列表（重名自动加序号），状态栏和小剧场的导出文件互导会被拦截。",
                "状态栏方案让 AI 在 <story_status> 标签里输出结构化数据（时间/地点/关系温度等），内容默认进入下一轮上下文。",
                "小剧场方案让 AI 在 <story_theater> 标签里写一段不影响主线的加演短文，默认仅展示、不进入上下文。",
                "渲染画布在沙盒 iframe 里运行，通过 window.STORY_RAW 或 {{RAW}} 读取输出原文；小剧场额外有 window.THEATER_RAW。",
                "小卷可以通过「剧情方案套件」列出、读取、创建、更新、删除这些方案；线上聊天的状态栏走「线上聊天状态栏套件」，两者不要混。",
            ],
        },
        {
            id: "meeting-invite-card",
            title: "邀请见面卡片 HTML 自定义",
            location: "聊天 → 我的 → 全局聊天信息 → 邀请见面卡片 CSS 样式",
            facts: [
                "邀请见面卡片支持完整 HTML/CSS/JS，不只是 CSS；可编辑角色邀请触发契约、输出渲染和预览示例数据。",
                "HTML 通过 window.STATUS_RAW 或 {{RAW}} 读取邀请人、标题、说明和状态；同意/拒绝按钮必须分别使用 data-meeting-action=accept 与 data-meeting-action=decline 才能真实交互。",
                "小卷可通过「邀请见面卡片套件」读取、写入并弹窗预览这份全局私聊方案；保存后所有私聊共用。",
            ],
        },
        {
            id: "story-custom-font",
            title: "剧情自定义字体",
            location: "剧情 App → 右上角设置 → 自定义字体",
            facts: [
                "可为当前剧情会话上传 TTF、OTF、WOFF、WOFF2 字体文件，也可填写以 http/https 开头的字体直链。",
                "字体会作用于剧情正文、目录、设置和输入区；远程字体如果不允许跨域，浏览器会自动回退到默认剧情字体。",
            ],
        },
        {
            id: "appearance-icon-url",
            title: "外观 App 图标 URL",
            location: "外观 App → Icons",
            facts: [
                "每个内置 App 与自定义 App 图标下面都有独立图床 URL 输入框，填写直链后点“应用 URL”即可替换该图标。",
                "也仍可直接点击图标从相册上传；清空 URL 并应用或点图标上的还原按钮会恢复默认图标。",
            ],
        },
        {
            id: "story-quick-input",
            title: "剧情快捷输入面板",
            location: "剧情 App → 右上角设置 → 快捷输入面板",
            facts: [
                "开启后“续写”右侧出现“输入”按钮，点按可在输入框上方展开/收起一条窄长的横幅面板，选项过多时可左右滑动。",
                "点按面板选项会把该内容插入到输入框光标处；插入后光标停在选项左边、中间还是右边，可以在设置里选择（“中间”适合成对引号，光标落在引号正中）。",
                "默认选项为 “” 「」 ，？ ……，用户可以在设置里自定义增删选项。",
                "设置保存在当前角色的剧情会话里，每个角色独立。",
            ],
        },
        {
            id: "backup-image-range",
            title: "备份动态图片时间范围",
            location: "设置 → 数据管理 → 动态图片备份范围",
            facts: [
                "本地导出可选择全部、最近 7 天或最近 3 天的聊天与朋友圈动态图片。",
                "用户/角色头像、主题图片、图标和壁纸不受时间范围限制，会完整保留。",
            ],
        },
    ],
};

function openKnowledgeDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(MASCOT_KNOWLEDGE_DB_NAME, MASCOT_KNOWLEDGE_DB_VERSION);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(MASCOT_KNOWLEDGE_STORE)) {
                request.result.createObjectStore(MASCOT_KNOWLEDGE_STORE, { keyPath: "key" });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("小卷功能知识库打开失败"));
    });
}

async function readKnowledgeRecord(db: IDBDatabase): Promise<MascotFeatureKnowledgeRecord | null> {
    return new Promise(resolve => {
        const tx = db.transaction(MASCOT_KNOWLEDGE_STORE, "readonly");
        const request = tx.objectStore(MASCOT_KNOWLEDGE_STORE).get(OWNER_FEATURES_KEY);
        request.onsuccess = () => resolve((request.result as MascotFeatureKnowledgeRecord | undefined) || null);
        request.onerror = () => resolve(null);
    });
}

async function writeKnowledgeRecord(db: IDBDatabase, record: MascotFeatureKnowledgeRecord): Promise<void> {
    return new Promise(resolve => {
        const tx = db.transaction(MASCOT_KNOWLEDGE_STORE, "readwrite");
        tx.objectStore(MASCOT_KNOWLEDGE_STORE).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
    });
}

function formatFeatureKnowledge(record: MascotFeatureKnowledgeRecord): string {
    const lines = record.entries.flatMap(entry => [
        `【${entry.title}】位置：${entry.location}`,
        ...entry.facts.map(fact => `- ${fact}`),
    ]);
    return [
        "===== 当前机型功能知识（本机数据库） =====",
        "以下是本分支已经实现的功能。用户询问位置、用法或是否支持时，以这里为准。",
        "知道功能存在不等于你能直接操作：只有当前工具列表提供对应动作时才可以替用户执行，否则应说明路径，让用户手动操作。",
        ...lines,
    ].join("\n");
}

export async function loadMascotFeatureKnowledgePrompt(): Promise<string> {
    if (typeof indexedDB === "undefined") return formatFeatureKnowledge(OWNER_FEATURES);
    try {
        const db = await openKnowledgeDb();
        let record = await readKnowledgeRecord(db);
        if (!record || record.revision !== OWNER_FEATURES.revision) {
            record = OWNER_FEATURES;
            await writeKnowledgeRecord(db, record);
        }
        db.close();
        return formatFeatureKnowledge(record);
    } catch {
        return formatFeatureKnowledge(OWNER_FEATURES);
    }
}
