/**
 * 云服务公开配置（来自 cloud-service 激活结果）。
 *
 * 这两个值都是**可公开**的：endpoint 是本应用的发布域数据面地址，
 * publishableKey 只用来标识"哪个应用"，本身不带权限（服务端还会校验 Origin）。
 * 它们会随前端代码一起发到浏览器，所以放在源码里没问题；但不要写进日志。
 *
 * 真正的免密钥大模型调用由 cloud.llm 处理，前端不持有任何模型服务的密钥。
 */
export const CLOUD_CONFIG = {
  endpoint: 'https://hearth-room.app.workbuddy.host',
  publishableKey: 'wbpk_hJ7RgIZjWLvnDA3MXc1v3k_w9l72Vg335ydb68Aq37McnEoIg2KlTDP',
} as const;
