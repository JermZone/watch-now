const storageKey = 'dispatcharr-now-appearance';

export const readAppearance = () => {
  try {
    return window.localStorage.getItem(storageKey) === 'green' ? 'green' : 'blue';
  } catch {
    return 'blue';
  }
};

export const applyAppearance = (appearance) => {
  const color = appearance === 'green' ? 'green' : 'blue';
  document.documentElement.dataset.theme = color;
  try {
    window.localStorage.setItem(storageKey, color);
  } catch {
    // Appearance still changes for this page when device storage is unavailable.
  }
};
