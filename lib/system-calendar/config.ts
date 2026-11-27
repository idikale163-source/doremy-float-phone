"use client";

// 系统日历的开关配置。
//
// 读 / 写分开两个开关：用户可能只想让角色知情，不接受被写入。
// 两项都默认关闭——涉及真实日历数据，必须用户主动开。

import { kvGet, kvSet, registerKvMigration } from "../kv-db";

const CONFIG_KEY = "ai_phone_system_calendar_config_v1";
registerKvMigration(CONFIG_KEY);

export type SystemCalendarConfig = {
  /** 允许角色读系统日历（只读标题/时间/地点）。默认关。 */
  readEnabled: boolean;
  /** 允许角色往系统日历新增纪念日（只能新增，不能改删）。默认关。 */
  writeEnabled: boolean;
};

export const SYSTEM_CALENDAR_DEFAULTS: SystemCalendarConfig = {
  readEnabled: false,
  writeEnabled: false,
};

export function loadSystemCalendarConfig(): SystemCalendarConfig {
  try {
    const raw = kvGet(CONFIG_KEY);
    if (!raw) return { ...SYSTEM_CALENDAR_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<SystemCalendarConfig>;
    return {
      readEnabled: parsed.readEnabled === true,
      writeEnabled: parsed.writeEnabled === true,
    };
  } catch {
    return { ...SYSTEM_CALENDAR_DEFAULTS };
  }
}

export function saveSystemCalendarConfig(config: SystemCalendarConfig): void {
  kvSet(CONFIG_KEY, JSON.stringify(config));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("system-calendar-config-changed"));
  }
}
