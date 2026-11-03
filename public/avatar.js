document.addEventListener('error', event => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.classList.contains('avatar-image') || image.dataset.fallbackApplied === '1') return;
  image.dataset.fallbackApplied = '1';
  image.hidden = true;
}, true);

const input = document.querySelector('#avatar_url');
const preview = document.querySelector('[data-avatar-preview]');
if (input && preview) {
  input.addEventListener('input', () => {
    const frame = preview.querySelector('.avatar');
    if (!frame) return;
    let image = frame.querySelector('.avatar-image');
    const value = input.value.trim();
    if (!value) {
      if (image) image.hidden = true;
      return;
    }
    let url;
    try { url = new URL(value); } catch { return; }
    if (url.protocol !== 'https:' || url.username || url.password) return;
    if (!image) {
      image = document.createElement('img');
      image.className = 'avatar-image';
      image.alt = 'Profile picture preview';
      image.width = 112;
      image.height = 112;
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      frame.append(image);
    }
    image.dataset.fallbackApplied = '';
    image.hidden = false;
    if (image.src !== url.href) image.src = url.href;
  });
}
