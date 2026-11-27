"use client";

// 自定义状态栏渲染画布：用户在聊天信息页写的「输出渲染」HTML 在沙盒 iframe 里执行，
// AI 的 [状态栏] 壳内原文通过 window.STATUS_RAW（JS 取用）与 {{RAW}}（模板直插，已转义）注入。
// 高度自适应桥与剧场画布同款；allow-scripts 无 same-origin，碰不到宿主页面与数据。

import { useEffect, useMemo, useRef, useState } from "react";

const FRAME_MIN_HEIGHT = 36;
const FRAME_MAX_HEIGHT = 5000;

function escapeHtmlText(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serializeForInlineScript(value: string): string {
    return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function buildSrcDoc(html: string, raw: string, frameId: string, kind: "status" | "theater" | "meeting"): string {
    const withRaw = html.split("{{RAW}}").join(escapeHtmlText(raw));
    const base = /<html[\s>]/i.test(withRaw)
        ? withRaw
        : `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body>${withRaw}</body></html>`;
    const serializedRaw = serializeForInlineScript(raw);
    const inject = `<script>window.STATUS_RAW=${serializedRaw};window.STORY_RAW=${serializedRaw};window.STORY_TAIL_KIND=${JSON.stringify(kind)};${kind === "theater" ? `window.THEATER_RAW=${serializedRaw};` : ""}</` + `script>`;
    return /<head[\s>]/i.test(base)
        ? base.replace(/<head([^>]*)>/i, `<head$1>${inject}`)
        : inject + base;
}

export function CustomStatusFrame({ html, raw, kind = "status", title = "自定义状态栏", onAction }: { html: string; raw: string; kind?: "status" | "theater" | "meeting"; title?: string; onAction?: (action: "accept" | "decline") => void }) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const [frameId] = useState(() => `csf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const [height, setHeight] = useState(FRAME_MIN_HEIGHT);

    const srcDoc = useMemo(() => {
        const doc = buildSrcDoc(html, raw, frameId, kind);
        const bridge = `<script>(function(){
  var frameId=${JSON.stringify(frameId)};
  var lastHeight=0,raf=0;
  function measure(){var b=document.body,d=document.documentElement;if(!b||!d)return ${FRAME_MIN_HEIGHT};var br=b.getBoundingClientRect(),dr=d.getBoundingClientRect();var h=Math.max(b.scrollHeight,b.offsetHeight,d.scrollHeight,d.offsetHeight,br.height,dr.height);
    var nodes=b.querySelectorAll('*');for(var i=0;i<nodes.length;i++){var c=nodes[i].getBoundingClientRect();if(c.width||c.height)h=Math.max(h,c.bottom-Math.min(br.top,dr.top));}
    return Math.max(Math.ceil(h),${FRAME_MIN_HEIGHT});}
  function send(){var h=measure();if(h===lastHeight)return;lastHeight=h;parent.postMessage({source:'chat-status-frame',type:'resize',id:frameId,height:h},'*');}
  function sched(){if(raf)return;raf=requestAnimationFrame(function(){raf=0;send();requestAnimationFrame(send);});}
  window.addEventListener('load',sched);window.addEventListener('resize',sched);
  if(window.MutationObserver)new MutationObserver(sched).observe(document.documentElement,{attributes:true,childList:true,subtree:true,characterData:true});
  if(window.ResizeObserver){var ro=new ResizeObserver(sched);ro.observe(document.documentElement);ro.observe(document.body);}
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(sched);
  for(var i=0;i<document.images.length;i++){document.images[i].addEventListener('load',sched);document.images[i].addEventListener('error',sched);}
  document.addEventListener('click',function(event){var target=event.target&&event.target.closest?event.target.closest('[data-meeting-action]'):null;if(!target)return;var action=target.getAttribute('data-meeting-action');if(action==='accept'||action==='decline'){event.preventDefault();parent.postMessage({source:'chat-status-frame',type:'meeting-action',id:frameId,action:action},'*')}});
  setTimeout(sched,30);setTimeout(sched,120);setTimeout(sched,500);setTimeout(sched,1500);
})();</` + `script>`;
        return /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, `${bridge}</body>`) : doc + bridge;
    }, [html, raw, frameId, kind]);

    useEffect(() => {
        // 切换方案/示例时先释放旧高度，避免较高的旧预览把新卡片撑出大片空白。
        setHeight(FRAME_MIN_HEIGHT);
    }, [html, raw, kind]);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;
            const data = event.data as Record<string, unknown> | null;
            if (!data || data.source !== "chat-status-frame" || data.type !== "resize" || data.id !== frameId) return;
            if (data.type === "resize") {
                const next = Number(data.height);
                if (Number.isFinite(next)) setHeight(Math.min(Math.max(next, FRAME_MIN_HEIGHT), FRAME_MAX_HEIGHT));
            }
        };
        window.addEventListener("message", handleMessage);
        return () => window.removeEventListener("message", handleMessage);
    }, [frameId]);

    useEffect(() => {
        const handleAction = (event: MessageEvent) => {
            if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;
            const data = event.data as Record<string, unknown> | null;
            if (!data || data.source !== "chat-status-frame" || data.type !== "meeting-action" || data.id !== frameId) return;
            if (data.action === "accept" || data.action === "decline") onAction?.(data.action);
        };
        window.addEventListener("message", handleAction);
        return () => window.removeEventListener("message", handleAction);
    }, [frameId, onAction]);

    return (
        <iframe
            ref={iframeRef}
            title={title}
            sandbox="allow-scripts"
            scrolling="no"
            srcDoc={srcDoc}
            style={{ width: "100%", height, border: 0, display: "block", background: "transparent" }}
        />
    );
}
