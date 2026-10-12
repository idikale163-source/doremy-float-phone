"use client";

// components/chat-plugin-bootstrap.tsx
// 聊天插件运行时启动引导：应用挂载后加载全部启用插件。
// 放在根布局，保证插件的 hook 在用户进入聊天前就已注册。

import { useEffect } from "react";
import { hydrateKvDb } from "@/lib/kv-db";
import { loadChatPlugins } from "@/lib/chat-plugin-storage";
import {
    getChatPluginRuntime,
    setChatPluginSafeMode,
} from "@/lib/chat-plugin-runtime";

const EMERGENCY_BLOCKED_PLUGIN_IDS = new Set([
    "image-api-floating-ball",
    "emergency-touch-repair",
]);

export function ChatPluginBootstrap() {
    useEffect(() => {
        void (async () => {
            // 先读取 iOS 桌面 Web App 自己的本地数据库，再启动任何插件。
            await hydrateKvDb();

            // 只要已确认会锁死触控的插件仍处于启用状态，就进入安全模式。
            // 这里只改变插件启动状态，不删除角色、聊天、图片、API 或备份数据。
            const hasBlockedPlugin = loadChatPlugins().some(
                plugin => plugin.enabled && EMERGENCY_BLOCKED_PLUGIN_IDS.has(plugin.manifest.id),
            );
            if (hasBlockedPlugin) setChatPluginSafeMode(true);

            await getChatPluginRuntime().ensureStarted();
        })();
    }, []);

    return null;
}
