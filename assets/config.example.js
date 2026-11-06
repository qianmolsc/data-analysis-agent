/* 云端服务公开配置模板
 * 使用方法：复制本文件为 assets/config.js，填入你自己的云端服务参数
 * 注意：publishableKey 是可以公开下发的客户端公钥，但请不要把它提交到公开仓库，
 *      避免他人 clone 后直接消耗你的数据库额度。
 */
window.APP_CONFIG = {
  cloud: {
    /* 你的应用域名（云服务环境地址） */
    endpoint: 'https://YOUR-APP-DOMAIN.app.workbuddy.host',
    /* OAuth 中转服务，使用 WorkBuddy 云服务时保持默认即可 */
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    /* 云服务控制台签发的客户端公钥，形如 wbpk_xxx */
    publishableKey: 'wbpk_YOUR_PUBLISHABLE_KEY'
  },
  limits: {
    /* 单个数据集最多保留的行数 */
    maxRows: 3000,
    /* 最多列数 */
    maxColumns: 60,
    /* 上传文件大小上限（MB） */
    maxFileMB: 8,
    /* 单个问题的最大字符数 */
    maxPromptChars: 400
  }
};
