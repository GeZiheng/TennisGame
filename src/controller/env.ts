/**
 * 球拍端环境自检。
 *
 * 目的不是「报个错」，而是把「为什么拿不到传感器」翻译成一条人能照着做的动作。
 *
 * 判断顺序是有讲究的：
 *   1. 内置浏览器（微信、QQ、钉钉…）在前 —— 这些 WebView 里连地址换成 HTTPS 也没用，
 *      必须先换浏览器，否则用户会在 HTTPS 上白折腾一遍
 *   2. 非安全上下文在后 —— http://192.168.x.x 这类地址，Chrome 和 Safari 都只给
 *      localhost / HTTPS 开放运动传感器
 *   3. 最后才是「浏览器确实没这个接口」
 */

export type IssueId = 'in-app-browser' | 'insecure' | 'unsupported' | 'no-events';

export interface EnvIssue {
  id: IssueId;
  title: string;
  detail: string;
  steps: string[];
}

export interface EnvFacts {
  ua: string;
  /** 识别到的内置浏览器名，例如「微信」；null 表示不是内置浏览器 */
  inApp: string | null;
  secure: boolean;
  hasMotion: boolean;
  hasOrientation: boolean;
  hasPermissionApi: boolean;
  host: string;
  isIOS: boolean;
  isAndroid: boolean;
}

/** 内置浏览器的 UA 特征。命中任何一个，运动传感器基本都拿不到。 */
const IN_APP: Array<[RegExp, string]> = [
  [/MicroMessenger/i, '微信'],
  [/DingTalk/i, '钉钉'],
  [/Lark|Feishu/i, '飞书'],
  [/AlipayClient/i, '支付宝'],
  [/Weibo/i, '微博'],
  [/aweme|BytedanceWebview/i, '抖音'],
  [/baiduboxapp/i, '百度 App'],
  [/QQ\//, 'QQ'],
];

function detectInApp(ua: string): string | null {
  for (const [re, name] of IN_APP) if (re.test(ua)) return name;
  return null;
}

function isLocalHost(host: string) {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

export function readFacts(): EnvFacts {
  const ua = navigator.userAgent;
  return {
    ua,
    inApp: detectInApp(ua),
    secure: typeof window.isSecureContext === 'boolean' ? window.isSecureContext : location.protocol === 'https:',
    hasMotion: typeof DeviceMotionEvent !== 'undefined',
    hasOrientation: typeof DeviceOrientationEvent !== 'undefined',
    hasPermissionApi:
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof (DeviceMotionEvent as unknown as { requestPermission?: unknown }).requestPermission === 'function',
    host: location.host,
    isIOS: /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    isAndroid: /Android/i.test(ua),
  };
}

export function diagnose(): { facts: EnvFacts; issues: EnvIssue[] } {
  const f = readFacts();
  const issues: EnvIssue[] = [];

  if (f.inApp) {
    issues.push({
      id: 'in-app-browser',
      title: `你现在是在${f.inApp}里打开的`,
      detail: `${f.inApp}内置浏览器是个受限 WebView，运动传感器被它挡在外面，网页拿不到 DeviceMotion。这个限制跟地址没关系，换 HTTPS 也绕不过去。`,
      steps: [
        f.isIOS ? '点右上角「⋯」，选「在浏览器打开」' : '点右上角「⋮」，选「在浏览器打开」',
        '没有这个选项的话，长按下面的地址复制，粘贴到 Chrome / Safari 的地址栏',
        '地址必须是 https:// 开头——http 的地址换到哪个浏览器都读不到传感器',
      ],
    });
  }

  if (!f.secure && !isLocalHost(location.hostname)) {
    issues.push({
      id: 'insecure',
      title: '这个地址是 http://，浏览器不会给传感器数据',
      detail:
        'Chrome 和 Safari 只在「安全上下文」里开放运动传感器——也就是 HTTPS，或者 localhost。用局域网 IP 走 http 一律被静默拦截。',
      steps: [
        '在电脑上停掉当前服务，改用 npm run dev:https 启动（会自动生成带局域网 IP 的证书）',
        '用终端打印的 https://192.168.x.x:5174 重新打开大屏，让手机扫那个新二维码',
        '手机上首次打开会提示证书不受信任，选「继续访问」（iOS 是「显示详细信息 → 访问此网站」）',
        '想彻底去掉红锁：浏览器打开 https://<电脑IP>:5174/ca.crt 装上根证书，见 README',
      ],
    });
  }

  if (f.secure && !f.hasMotion && !f.inApp) {
    issues.push({
      id: 'unsupported',
      title: '这个浏览器没有 DeviceMotion 接口',
      detail:
        '安全上下文是正常的，但这个浏览器确实没实现 DeviceMotion，多半是定制内核或者很旧的版本。',
      steps: ['iOS 用系统自带 Safari，Android 用 Chrome', '如果是 App 内嵌页面，换系统浏览器再试'],
    });
  }

  return { facts: f, issues };
}

/** 接口在、事件不来时用这一条。跟上面的静态判断互补。 */
export function noEventsIssue(f: EnvFacts): EnvIssue {
  return {
    id: 'no-events',
    title: '传感器接口在，但 800ms 内没收到任何数据',
    detail:
      '接口存在却一条事件都没来，通常是三种情况：权限被拒、系统里关掉了「运动与方向访问」、或者页面不在前台。',
    steps: [
      '刷新页面，在弹出的权限框里点「允许」',
      f.isIOS ? 'iOS 设置 → Safari → 运动与方向访问 → 打开' : 'Android 设置 → 应用 → 浏览器 → 权限，确认没有被禁止',
      '保持这个页面在前台，不要切到别的 App',
    ],
  };
}

/** 这些原因可以确定「点了开始也白点」，按钮就没必要让人点。 */
export function isFatal(issues: EnvIssue[]): boolean {
  return issues.some((i) => i.id !== 'no-events');
}
