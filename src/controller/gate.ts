/**
 * 手机端「开始之前」那一屏：环境自检结论、复制链接、演示模式入口。
 *
 * 从 `main.ts` 搬出来的原因：这一整块（诊断卡片、事实行、剪贴板降级）只在
 * **用户点开始之前**有意义，和姿态流水线没有一行交集。唯一的耦合是「致命问题
 * 就把开始按钮藏起来」——那是 `initGate()` 的最后一个动作。
 */

import { isFatal, noEventsIssue, type EnvFacts, type EnvIssue } from './env';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface GateEnv {
  facts: EnvFacts | null;
  issues: EnvIssue[];
}

/**
 * 逐条画诊断卡片。
 *
 * 每条都带「症状 → 原因 → 三步操作」，因为手机端出问题的现场是**站着、单手、
 * 大屏在对面**——用户没有第二块屏幕去查文档。
 */
function renderDiag(issues: EnvIssue[]) {
  const gateDiag = $<HTMLDivElement>('gate-diag');
  gateDiag.textContent = '';
  if (issues.length === 0) {
    gateDiag.hidden = true;
    return;
  }
  gateDiag.hidden = false;
  for (const issue of issues) {
    const card = document.createElement('div');
    card.className = 'diag-card';

    const title = document.createElement('div');
    title.className = 'diag-title';
    title.textContent = issue.title;

    const detail = document.createElement('p');
    detail.className = 'diag-detail';
    detail.textContent = issue.detail;

    const steps = document.createElement('ol');
    steps.className = 'diag-steps';
    for (const s of issue.steps) {
      const li = document.createElement('li');
      li.textContent = s;
      steps.append(li);
    }

    card.append(title, detail, steps);
    gateDiag.append(card);
  }
}

/** 一行事实摘要：安全上下文 / DeviceMotion / 平台。三个都对才是绿的。 */
function renderFacts(f: EnvFacts) {
  const mark = (ok: boolean) => (ok ? '✓' : '✗');
  const who = f.inApp ?? (f.isIOS ? 'iOS' : f.isAndroid ? 'Android' : '桌面浏览器');
  const gateFacts = $<HTMLParagraphElement>('gate-facts');
  gateFacts.textContent = `安全上下文 ${mark(f.secure)} · DeviceMotion ${mark(f.hasMotion)} · ${who}`;
  const good = f.secure && f.hasMotion && !f.inApp;
  gateFacts.className = `gate-facts ${good ? 'ok' : 'bad'}`;
}

async function copyCurrentUrl() {
  const url = location.href;
  const gateUrl = $<HTMLInputElement>('gate-url');
  const copyBtn = $<HTMLButtonElement>('copy-link');
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // http 页面拿不到剪贴板权限，退回 execCommand；还不行就靠用户长按输入框
    try {
      gateUrl.select();
      gateUrl.setSelectionRange(0, url.length);
      document.execCommand('copy');
    } catch {
      /* 让用户手动长按复制，下面会有提示 */
    }
  }
  copyBtn.textContent = '已复制，去浏览器粘贴';
  setTimeout(() => (copyBtn.textContent = '复制链接'), 2200);
}

/**
 * 装上这一屏。
 *
 * demo 模式（`?demo=1`，在电脑上预览界面用）传 `facts: null`，什么都不画。
 */
export function initGate(env: GateEnv) {
  $<HTMLButtonElement>('copy-link').addEventListener('click', copyCurrentUrl);

  $<HTMLButtonElement>('demo-btn').addEventListener('click', () => {
    const u = new URL(location.href);
    u.searchParams.set('demo', '1');
    location.replace(u.toString());
  });

  const facts = env.facts;
  if (!facts) return;
  renderFacts(facts);
  renderDiag(env.issues);
  $<HTMLInputElement>('gate-url').value = location.href;

  if (isFatal(env.issues)) {
    // 确定拿不到数据的情况下，别让人白点一次按钮
    $<HTMLHeadingElement>('gate-title').textContent = '这个环境拿不到传感器';
    $<HTMLParagraphElement>('gate-hint').hidden = true;
    $<HTMLButtonElement>('start').hidden = true;
    $<HTMLDivElement>('gate-actions').hidden = false;
  }
}

/**
 * 传感器出错：换掉诊断卡片，把「没收到方向事件」这一张放到最后。
 *
 * 和 `initGate()` 里那张静态诊断不同，这一张是**运行期**才出现的——用户已经点了
 * 开始、权限也给了，但事件始终不来。所以它必须覆盖掉「看起来一切正常」的那一屏。
 */
export function showNoEvents(env: GateEnv, msg: string) {
  $<HTMLParagraphElement>('gate-msg').textContent = msg;
  if (!env.facts) return;
  renderDiag([...env.issues.filter((i) => i.id !== 'no-events'), noEventsIssue(env.facts)]);
}
