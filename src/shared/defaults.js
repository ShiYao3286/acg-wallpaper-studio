// 默认配置与常量(主进程/渲染进程共用)
const DEFAULT_CONFIG = {
  // 壁纸来源: lolicon | ai
  source: 'lolicon',
  lolicon: {
    r18: 0,
    size: 'regular',
    proxy: 'i.pixiv.re',
    excludeAI: true,
    tags: ['原神', '碧蓝航线', '蔚蓝档案', '崩坏:星穹铁道', '明日方舟', '東方Project', '初音ミク'],
    apiBase: 'https://api.lolicon.app/setu/v2',
  },
  // API 服务列表(kind: image=画图 / text=文本),id 由时间戳生成
  services: [
    {
      id: 'svc-default-image',
      name: '默认生图服务',
      kind: 'image',
      apiBase: 'https://nb.deepsb.com',
      apiKey: 'sk-90ba7048131868b995685d881cab5740fc48778a9d05de0f31c553e515c2a7d1',
      model: 'gpt-image-2.6',
    },
  ],
  // 当前使用的服务 id(画图与文本分开记)
  activeImageService: 'svc-default-image',
  activeTextService: '',   // 空 = 未配置文本模型
  ai: {
    prompt: 'anime wallpaper, beautiful scenery, girl, detailed, high quality',
    size: '1536x1024',
    // 随机生成模式: any=完全随机 portrait=锁定人物 scenery=锁定风景 custom=自定义提示词
    randomMode: 'any',
  },
  // 提示词预设槽
  promptPresets: [
    { id: 'preset-1', name: '风景系', prompt: 'anime wallpaper, scenic landscape, clouds, sunset sky, wide angle, detailed background, no humans, high quality' },
    { id: 'preset-2', name: '人物系', prompt: '1girl, solo, long hair, looking at viewer, detailed, beautiful, anime wallpaper, soft lighting' },
  ],
  schedule: { enabled: true, intervalMinutes: 30 },
  gameCheck: {
    enabled: true,
    processes: ['WardogsClient-Win64-Shipping', 'WardogsLauncher-Shipping'],
  },
  history: { keepCount: 30 },
  // 出网代理(访问 Lolicon / AI API 用):enabled=false 直连
  proxy: { enabled: false, url: 'http://127.0.0.1:7897' },
  migrate: { oldTaskDisabled: false },
};

// 本地风格词池:文本模型未配置时的提示词增强兜底
const STYLE_POOL = {
  quality: ['masterpiece', 'best quality', 'very aesthetic', 'absurdres', 'highres', 'detailed'],
  lighting: ['soft lighting', 'golden hour lighting', 'moonlight', 'backlighting', 'dappled sunlight', 'neon lights', 'candlelight'],
  atmosphere: ['cinematic composition', 'epic composition', 'dreamy atmosphere', 'ethereal glow', 'dynamic angle', 'depth of field'],
  scene: ['cherry blossoms', 'starry night sky', 'ocean view', 'mountain peak', 'city skyline', 'enchanted forest', 'rainy window', 'autumn forest', 'sunset beach', 'snowfield'],
  color: ['vivid colors', 'pastel colors', 'purple theme', 'blue theme', 'warm colors', 'monochrome'],
};

// AI 随机生图词池(Danbooru 风格,组合空间巨大,几乎不重样)
const RANDOM_POOLS = {
  quality: ['masterpiece', 'best quality', 'very aesthetic', 'highly detailed', 'absurdres', 'wallpaper'],
  // 人物元素
  hairColor: ['silver hair', 'black hair', 'white hair', 'purple hair', 'pink hair', 'blonde hair', 'blue hair', 'brown hair', 'red hair', 'aqua hair'],
  hairStyle: ['long hair', 'short hair', 'twintails', 'ponytail', 'braid', 'wavy hair', 'straight hair', 'hair between eyes'],
  eyes: ['blue eyes', 'purple eyes', 'golden eyes', 'red eyes', 'green eyes', 'heterochromia', 'aqua eyes'],
  outfit: ['sailor uniform', 'school uniform', 'maid outfit', 'kimono', 'gothic lolita dress', 'winter coat', 'hoodie', 'china dress', 'wedding dress', 'idol costume', 'summer dress', 'uniform jacket'],
  expression: ['smile', 'gentle smile', 'shy blush', 'cool expression', 'surprised', 'closed eyes smile'],
  pose: ['looking at viewer', 'looking back', 'sitting', 'standing in wind', 'walking', 'looking out window', 'arms behind back', 'head tilt'],
  // 场景元素(人物背景 + 风景主体共用)
  scene: ['cherry blossoms', 'night city skyline', 'starry sky', 'sunset beach', 'snowy street', 'flower field', 'rainy window', 'autumn forest', 'shrine at dusk', 'cafe interior', 'library', 'rooftop', 'lakeside', 'harbor town', 'bamboo forest', 'meadow with clouds'],
  // 风景元素
  landscape: ['towering snow mountains', 'alpine lake reflection', 'ancient forest', 'coastline cliffs', 'city skyline at night', 'waterfall in mist', 'rolling wheat fields', 'aurora over frozen lake', 'desert dunes', 'moonlit sea', 'mountain valley', 'rice terraces'],
  timeWeather: ['golden hour', 'sunset glow', 'moonlight', 'dawn mist', 'overcast', 'clear night', 'light rain', 'falling snow', 'sea of clouds', 'sunbeam through trees'],
  colorTone: ['vivid colors', 'pastel colors', 'purple theme', 'warm colors', 'cold colors', 'monochrome accent'],
  composition: ['wide shot', 'scenic composition', 'dynamic angle', 'cinematic composition', 'depth of field', 'panorama'],
};
// 组装随机提示词: mode = portrait | scenery | any
function buildRandomPrompt(mode) {
  const P = RANDOM_POOLS;
  const pick = (arr, n = 1) => {
    const c = [...arr].sort(() => Math.random() - 0.5).slice(0, n);
    return c;
  };
  let core;
  if (mode === 'portrait') {
    core = [
      '1girl, solo',
      ...pick(P.hairColor, 1), ...pick(P.hairStyle, 1), ...pick(P.eyes, 1),
      ...pick(P.outfit, 1), ...pick(P.expression, 1), ...pick(P.pose, 1),
      ...pick(P.scene, 1),
    ];
    core = core.join(', ');
  } else if (mode === 'scenery') {
    core = [
      'no humans',
      ...pick(P.landscape, 1), ...pick(P.timeWeather, 2), ...pick(P.colorTone, 1),
      ...pick(P.scene, 1),
    ];
    core = core.join(', ');
  } else {
    // any:五五开,递归拿到的已是字符串
    core = Math.random() < 0.5
      ? buildRandomPrompt('portrait')
      : buildRandomPrompt('scenery');
    return [core, ...pick(P.composition, 1), ...pick(P.quality, 2)].join(', ');
  }
  return [core, ...pick(P.composition, 1), ...pick(P.quality, 2)].join(', ');
}

module.exports = { DEFAULT_CONFIG, STYLE_POOL, RANDOM_POOLS, buildRandomPrompt };
