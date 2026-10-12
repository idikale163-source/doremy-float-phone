"use client";

import { useEffect } from "react";

const STORY_SCROLL_FIX = `
.story-app-shell .story-stage {
  overflow-y: auto !important;
  overflow-x: hidden !important;
  touch-action: pan-y !important;
  -webkit-overflow-scrolling: touch;
  scroll-behavior: auto !important;
}
`;

export function StoryScrollFix() {
  useEffect(() => {
    const style = document.createElement("style");
    style.setAttribute("data-story-scroll-fix", "true");
    style.textContent = STORY_SCROLL_FIX;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  return null;
}
