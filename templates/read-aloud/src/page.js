import { initReadAloudPage } from './reader.js';
const init = () => void initReadAloudPage();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
