import './style.css';
import { Game } from './game';
import { voice } from './audio/voice';

const root = document.getElementById('app');
if (!root) throw new Error('缺少 #app 挂载点');

// 屏蔽双指缩放与双击缩放，避免误触导致画面跳变
document.addEventListener('gesturestart', (e) => e.preventDefault());
let lastTouch = 0;
document.addEventListener(
  'touchend',
  (e) => {
    const now = Date.now();
    if (now - lastTouch < 300) e.preventDefault();
    lastTouch = now;
  },
  { passive: false },
);

// 语音需要用户先交互一次才能播，抓住第一次点击
document.addEventListener(
  'pointerdown',
  () => voice.unlock(),
  { once: true },
);

const game = new Game(root);
game.start();

// 调试入口：控制台里可查看与修改状态
(window as unknown as { game: Game }).game = game;

// 兜底错误显示：手机端没有控制台，出错时必须让玩家看见
window.addEventListener('error', (e) => showFatal(e.message));
window.addEventListener('unhandledrejection', (e) =>
  showFatal(String((e as PromiseRejectionEvent).reason)),
);

function showFatal(msg: string): void {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;left:8px;right:8px;bottom:8px;z-index:99;background:#3a1d1d;color:#ffd9d0;' +
    'font-size:12px;padding:8px;border-radius:8px;max-height:30vh;overflow:auto;white-space:pre-wrap';
  el.textContent = `运行出错：${msg}`;
  document.body.appendChild(el);
}