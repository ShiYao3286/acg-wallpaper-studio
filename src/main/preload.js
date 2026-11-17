const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (key, val) => ipcRenderer.invoke('save-config', key, val),
  changeWallpaper: (reason) => ipcRenderer.invoke('change-wallpaper', reason),  aiGenerate: (prompt) => ipcRenderer.invoke('ai-generate', prompt),
  aiApply: (taskId) => ipcRenderer.invoke('ai-apply', taskId),
  aiDiscard: (taskId) => ipcRenderer.invoke('ai-discard', taskId),
  aiPendingGet: () => ipcRenderer.invoke('ai-pending-get'),
  listHistory: () => ipcRenderer.invoke('list-history'),
  useHistory: (name) => ipcRenderer.invoke('use-history', name),
  getStatus: () => ipcRenderer.invoke('get-status'),
  getAutoRun: () => ipcRenderer.invoke('get-autorun'),
  setAutoRun: (on) => ipcRenderer.invoke('set-autorun', on),
  openWallpaperDir: () => ipcRenderer.invoke('open-wallpaper-dir'),
  addTag: (tag) => ipcRenderer.invoke('add-tag', tag),
  removeTag: (tag) => ipcRenderer.invoke('remove-tag', tag),
  disableOldTask: () => ipcRenderer.invoke('disable-old-task'),
  // API 服务
  listServices: () => ipcRenderer.invoke('list-services'),
  saveService: (svc) => ipcRenderer.invoke('save-service', svc),
  deleteService: (id) => ipcRenderer.invoke('delete-service', id),
  setActiveService: (kind, id) => ipcRenderer.invoke('set-active-service', kind, id),
  testService: (svc) => ipcRenderer.invoke('test-service', svc),
  fetchModels: (svc) => ipcRenderer.invoke('fetch-models', svc),
  // 提示词助手与预设
  aiAssistPrompt: (theme) => ipcRenderer.invoke('ai-assist-prompt', theme),
  savePreset: (p) => ipcRenderer.invoke('save-preset', p),
  deletePreset: (id) => ipcRenderer.invoke('delete-preset', id),
  // 收藏与元数据
  favoriteCurrent: () => ipcRenderer.invoke('favorite-current'),
  listFavorites: () => ipcRenderer.invoke('list-favorites'),
  deleteFavorite: (name) => ipcRenderer.invoke('delete-favorite', name),
  readMeta: (name) => ipcRenderer.invoke('read-meta', name),
  detectProxy: () => ipcRenderer.invoke('detect-proxy'),
  rollRandomPrompt: (mode) => ipcRenderer.invoke('roll-random-prompt', mode),
  // 主进程推送(旧脚本换图等文件事件)
  // 返回取消订阅函数;回调收到 reason('self' 本程序写入 / 'external' 旧脚本等外部写入 / 'models' 模型缓存更新)
  onUiRefresh: (cb) => {
    const handler = (_e, reason) => cb(reason);
    ipcRenderer.on('ui-refresh', handler);
    return () => ipcRenderer.removeListener('ui-refresh', handler);
  },
  queryOldTask: () => ipcRenderer.invoke('query-old-task'),
  // 插件管理(阶段2):listPlugins 返回元数据,不含实现对象
  listPlugins: () => ipcRenderer.invoke('list-plugins'),
  setPluginEnabled: (id, on) => ipcRenderer.invoke('set-plugin-enabled', id, on),
  // 豆包账号(阶段3)。返回值只含状态与时间戳,绝不含 Cookie。
  doubao: {
    status: () => ipcRenderer.invoke('doubao-status'),
    login: () => ipcRenderer.invoke('doubao-login'),
    cancelLogin: () => ipcRenderer.invoke('doubao-cancel-login'),
    logout: () => ipcRenderer.invoke('doubao-logout'),
    openLoginWindow: () => ipcRenderer.invoke('doubao-open-login-window'),
  sessionStatus: () => ipcRenderer.invoke('doubao-session-status'),
  newSession: () => ipcRenderer.invoke('doubao-new-session'),
    riskAccepted: () => ipcRenderer.invoke('doubao-risk-accepted'),
    acceptRisk: (accepted) => ipcRenderer.invoke('doubao-accept-risk', accepted),
    testText: (prompt) => ipcRenderer.invoke('doubao-test-text', prompt),
    testImage: (prompt) => ipcRenderer.invoke('doubao-test-image', prompt),
    models: () => ipcRenderer.invoke('doubao-models'),
    setModel: (modelKey, effort) => ipcRenderer.invoke('doubao-set-model', modelKey, effort),
  },
  win: {
    minimize: () => ipcRenderer.invoke('win-minimize'),
    close: () => ipcRenderer.invoke('win-close'),
  },
});
