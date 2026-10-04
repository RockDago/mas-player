// Le mode audio (playsInSilentMode, fond, interruption) est configuré par
// playerManager.init(), qui porte le même réglage : le garder ici aussi
// créerait deux chemins vers le même état, dont un mort.

export function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}
