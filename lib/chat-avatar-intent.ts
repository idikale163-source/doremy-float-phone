import type { ChatMessage } from "./chat-storage";

const AVATAR_INTENT_PATTERNS = [
    /(?:换|改|设置|设成|设为|用作|当作|作为|换上).{0,8}(?:头像|头图)/i,
    /(?:头像|头图).{0,8}(?:换|改|设置|设成|设为|用这张|用这个|用它)/i,
    /(?:给你|你|把这张|这张|这个|它).{0,10}(?:当|做|换成|设为|用作|作为|换上).{0,6}(?:头像|头图)/i,
    /(?:这张|这个|它).{0,8}(?:适合|很配).{0,6}(?:你).{0,6}(?:头像|头图)/i,
];

const AVATAR_DECISION_RE = /[\[【]\s*(?:接受|拒绝)头像推荐\s*[\]】]/g;
const AVATAR_DECISION_PLACEHOLDER_PREFIX = "\uE10Aai_phone_avatar_decision_";
const AVATAR_DECISION_PLACEHOLDER_SUFFIX = "_\uE10B";
const AVATAR_INTENT_LOOKBACK_MESSAGES = 12;
const AVATAR_INTENT_LOOKBACK_MS = 30 * 60 * 1000;

function isAvatarChangeIntent(text: string): boolean {
    const normalized = text.replace(/\s+/g, "").trim();
    if (!normalized) return false;
    // “我换头像了”是在告知自己的变化，不应误判成要求角色换头像。
    const describesOwnAvatar = /^(?:我|用户).{0,8}(?:刚|已经|又)?(?:换|改|设置).{0,5}(?:头像|头图)/i.test(normalized);
    const directsOtherToChange = /(?:给你|帮你|让你|你也|你要不要|你该|你应该|对方|TA|char).{0,10}(?:换|改|设置|用|当).{0,6}(?:头像|头图)/i.test(normalized)
        || /(?:把这张|这张|这个|它).{0,10}(?:换成|设为|用作|作为|当作).{0,6}(?:头像|头图)/i.test(normalized);
    if (describesOwnAvatar && !directsOtherToChange) return false;
    return AVATAR_INTENT_PATTERNS.some(pattern => pattern.test(normalized));
}

function isUserImage(message: ChatMessage): boolean {
    return message.role === "user"
        && Boolean(message.mediaUrl)
        && (message.mediaType === "image"
            || (message.mediaType === "media_file" && message.mediaData?.fileType === "image"));
}

function unresolvedImageForCharacter(message: ChatMessage, characterId?: string): boolean {
    if (!isUserImage(message)) return false;
    if (message.mediaData?.avatarRecommendationForCharacterId
        && message.mediaData.avatarRecommendationForCharacterId !== characterId) return false;
    return message.mediaData?.avatarRecommendationStatus !== "accepted"
        && message.mediaData?.avatarRecommendationStatus !== "declined";
}

function isRecentEnough(image: ChatMessage, reference: ChatMessage): boolean {
    const imageTime = Date.parse(image.createdAt);
    const referenceTime = Date.parse(reference.createdAt);
    if (!Number.isFinite(imageTime) || !Number.isFinite(referenceTime)) return true;
    return referenceTime - imageTime <= AVATAR_INTENT_LOOKBACK_MS;
}

/**
 * 识别最近一次用户换头像意图，并配对最近的真实相册图片。
 *
 * 构造 prompt 时历史以用户消息结尾；角色回复落库后历史会以 assistant 结尾。
 * 这里会先跳过最新一批 assistant 气泡，再读取它前面的用户轮次。若图片发出后
 * 自动触发过一次回复、用户才补一句“把刚才那张换成头像”，也允许跨一个回复批次
 * 向前找图，但最多回看 12 条、30 分钟，避免误用旧图。
 */
export function findUserAvatarChangeIntent(
    history: ChatMessage[],
    sessionId: string,
    characterId?: string,
): { image: ChatMessage; intentText: string } | null {
    const sessionMessages = history.filter(message => message.sessionId === sessionId);
    if (sessionMessages.length === 0) return null;

    // resolvePendingAvatarRecommendation 在角色消息已经入缓存后调用。跳过同一回复批次
    // 的尾部气泡，才能重新看到触发这次回复的用户输入。
    let endExclusive = sessionMessages.length;
    const trailing = sessionMessages[endExclusive - 1];
    if (trailing?.role === "assistant") {
        const trailingBatchId = trailing.responseBatchId;
        const trailingRaw = trailing.rawResponseText;
        while (endExclusive > 0) {
            const message = sessionMessages[endExclusive - 1];
            if (message.role !== "assistant") break;
            if (trailingBatchId && message.responseBatchId && message.responseBatchId !== trailingBatchId) break;
            if (!trailingBatchId && trailingRaw && message.rawResponseText && message.rawResponseText !== trailingRaw) break;
            endExclusive -= 1;
        }
    }

    const currentTurn: ChatMessage[] = [];
    let currentTurnStart = endExclusive;
    for (let index = endExclusive - 1; index >= 0; index -= 1) {
        const message = sessionMessages[index];
        if (message.role === "assistant") break;
        currentTurnStart = index;
        if (message.role === "user") currentTurn.unshift(message);
    }
    if (currentTurn.length === 0) return null;

    const intentText = currentTurn
        .flatMap(message => [message.content, message.mediaData?.label])
        .filter((value): value is string => Boolean(value?.trim()))
        .join("\n");
    if (!isAvatarChangeIntent(intentText)) return null;

    let image = [...currentTurn].reverse().find(message => unresolvedImageForCharacter(message, characterId));
    if (!image) {
        const reference = currentTurn[currentTurn.length - 1];
        const lookbackStart = Math.max(0, currentTurnStart - AVATAR_INTENT_LOOKBACK_MESSAGES);
        for (let index = currentTurnStart - 1; index >= lookbackStart; index -= 1) {
            const candidate = sessionMessages[index];
            if (!unresolvedImageForCharacter(candidate, characterId)) continue;
            if (!isRecentEnough(candidate, reference)) break;
            image = candidate;
            break;
        }
    }
    if (!image) return null;

    return { image, intentText };
}

/** 用户正则可以清理方括号标签；先占位、执行正则后再恢复头像控制标记。 */
export function applyWithProtectedAvatarDecisionMarkers(
    text: string,
    transform: (protectedText: string) => string,
): string {
    const markers: string[] = [];
    const protectedText = text.replace(AVATAR_DECISION_RE, marker => {
        const index = markers.push(marker) - 1;
        return `${AVATAR_DECISION_PLACEHOLDER_PREFIX}${index}${AVATAR_DECISION_PLACEHOLDER_SUFFIX}`;
    });
    const transformed = transform(protectedText);
    if (markers.length === 0) return transformed;
    const placeholderRe = new RegExp(`${AVATAR_DECISION_PLACEHOLDER_PREFIX}(\\d+)${AVATAR_DECISION_PLACEHOLDER_SUFFIX}`, "g");
    return transformed.replace(placeholderRe, (_placeholder, rawIndex: string) => markers[Number(rawIndex)] || "");
}

/** 模型偶尔漏写控制标记时，依据自然回复做保守兜底；拒绝词永远优先。 */
export function inferAvatarDecisionFromReply(text: string): "accepted" | "declined" | null {
    const normalized = text.replace(/\s+/g, "").trim();
    if (!normalized) return null;
    if (/[\[【]\s*拒绝头像推荐\s*[\]】]/.test(normalized)) return "declined";
    if (/[\[【]\s*接受头像推荐\s*[\]】]/.test(normalized)) return "accepted";
    if (/(?:不想|不愿|不要|不用|别|不换|算了|拒绝|还是算了).{0,10}(?:头像|这张|照片|图片|它)?/.test(normalized)
        || /(?:头像|这张|照片|图片|它).{0,10}(?:不想|不愿|不要|不用|不换|算了|拒绝)/.test(normalized)) {
        return "declined";
    }
    if (/(?:就用|换上|换成|设成|设为|当作头像|用作头像|收下|采用).{0,10}(?:这张|照片|图片|它|头像)?/.test(normalized)
        || /(?:这张|照片|图片|它).{0,12}(?:就用|换上|换成|设成|设为|当头像|收下|采用)/.test(normalized)) {
        return "accepted";
    }
    return null;
}
