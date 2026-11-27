/**
 * 设备动作：让角色能在真实手机上做一件小事。
 *
 * 与「感知」互补：感知只读（电量、网络、应用名、步数），这里只写
 * （手电筒、音量、屏幕亮度、勿扰模式）。
 *
 * 产品边界（改代码前先读）：
 *  - **默认全部关闭**。这是写操作，与只读的感知相反——感知缺省开，
 *    这里必须用户逐个打开。抄感知的默认值就等于默认允许角色动用户的设备。
 *  - 只接「能回答出为什么角色需要它」的动作。音量/亮度/勿扰/手电筒
 *    各有明确场景；「打开应用」答不上来（还会把用户踢出小手机），已剔除。
 *  - 刻意不做：发短信、打电话、读通讯录、装应用、改其他 App 的数据。
 *    这些会与「小手机里仿真聊天」的边界打架。
 *  - 失败必须说清原因：角色以为灯开了其实没开，比拒绝执行更糟。
 */

/** 可执行的设备动作标识。与原生 capabilitiesJson() 的键一一对应。 */
export type DeviceActionId =
  | "torch"
  | "volume"
  | "brightness"
  | "brightnessGranted"
  | "brightnessAuto"
  | "dnd"
  | "dndGranted"
  | "openApp"
  | "alarm"
  | "timer"
  | "media"
  | "mediaSessionGranted"
  | "openUrl"
  | "usageStats"
  | "usageStatsGranted";

/** 壳如实上报的设备动作支持表。 */
export type DeviceActionCapabilities = Partial<Record<DeviceActionId, boolean>>;

/**
 * 一次设备动作的结果。
 *
 * needPermission 有值时，说明「有能力但还没授权」，网页应引导用户去授权
 * （用 openSystemSettings）——这与「硬件根本没有」是两回事，不能混为一谈。
 */
export type DeviceActionResult =
  | {
      ok: true;
      on?: boolean;
      level?: number;
      current?: number;
      max?: number;
      package?: string;
      /**
       * 该应用的显示名（openApp 成功时回传）。
       *
       * 为什么要它：角色说的是「打开微信」，用户输的也可能是简称，
       * 而真正被打开的可能是「微信」的全名或另一个同名应用。
       * 回一句真实名字，用户才知道到底开了哪个——不然出错了都看不出。
       */
      label?: string;
      /** 亮度动作：值是否真的被系统采用（原生写后回读核对过）。 */
      applied?: boolean;
      /** 亮度动作：当前是否开着自动亮度（开着时系统可能很快把值改回去）。 */
      autoBrightness?: boolean;
      /** 媒体动作：是否**确认**指令真的生效了（读回播放状态核对过）。
       *  false 表示只是把指令发出去了，不代表播放器照做了——角色据此措辞。 */
      confirmed?: boolean;
      /** 媒体动作：是否走了会话直控（有通知使用权）。false 说明是盲发按键、无从确认。 */
      viaSession?: boolean;
      /** 媒体动作：会话直控没确认上时，是否又补发了一次系统媒体按键。
       *  补发过的失败比「什么都没做」更有希望——角色据此措辞更准确。 */
      viaKeys?: boolean;
      /** 媒体动作：会话在，但播放状态读不回来（播放器进程多半已退出，只剩空壳）。
       *  这与「读到了、只是没生效」是两回事，处置方式也不同（要重开播放器）。 */
      readable?: boolean;
      /** 媒体动作：会话直控下发时抛的异常类型名（如 DeadObjectException）。有值时
       *  说明会话是跨进程代理，播放器那边已经不在了。 */
      transportError?: string;
      /** 媒体动作：当前是否处于播放中（能读到状态时）。 */
      playing?: boolean;
      /** 媒体动作：被控制的播放器显示名（能识别到时）。 */
      player?: string;
    }
  | { ok: false; reason: string; needPermission?: string };

/** 音量流类型（与原生 streamFor 对应）。 */
export type VolumeStream = "media" | "ring" | "alarm" | "notification";

/** 音量操作。 */
export type VolumeAction = "up" | "down" | "set" | "mute";

/** 本机（壳）是否支持某个动作。 */
export function isActionSupported(
  capabilities: DeviceActionCapabilities,
  id: DeviceActionId,
): boolean {
  return capabilities[id] === true;
}
