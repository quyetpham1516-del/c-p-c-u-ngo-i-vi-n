/**
 * Chuông báo lệnh mới trên máy tính bảng của kíp: kêu và rung lặp lại cho tới khi kíp bấm "Xác nhận lệnh".
 * Trình duyệt chỉ cho phát tiếng sau khi người dùng đã chạm vào trang một lần, nên mở khóa âm thanh ở lần chạm đầu.
 */
let ctx: AudioContext | null = null;

export function unlockAudio(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
  } catch { /* trình duyệt không hỗ trợ âm thanh */ }
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}

function beep(): void {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  for (const [i, f] of [880, 660, 880].entries()) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = f;
    o.type = 'square';
    g.gain.setValueAtTime(0.0001, t + i * 0.25);
    g.gain.exponentialRampToValueAtTime(0.3, t + i * 0.25 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.25 + 0.22);
    o.connect(g).connect(ctx.destination);
    o.start(t + i * 0.25);
    o.stop(t + i * 0.25 + 0.24);
  }
}

/** Bắt đầu báo động; trả về hàm dừng */
export function startAlarm(title: string, body: string): () => void {
  const ring = () => {
    beep();
    try { navigator.vibrate?.([400, 150, 400]); } catch { /* bỏ qua */ }
  };
  ring();
  const timer = window.setInterval(ring, 2500);
  let note: Notification | null = null;
  try {
    if ('Notification' in window && Notification.permission === 'granted') note = new Notification(title, { body, requireInteraction: true, tag: 'medone-lenh' });
  } catch { /* bỏ qua */ }
  return () => { clearInterval(timer); note?.close(); try { navigator.vibrate?.(0); } catch { /* bỏ qua */ } };
}
