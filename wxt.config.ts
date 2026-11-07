import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  outDir: 'dist',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'Bo Translation · 沉浸式双语对照',
    short_name: 'Bo Translation',
    description: '围绕同一次阅读展开的网页与技术文档沉浸式双语对照插件：读到哪里译到哪里，支持悬停翻译、上下文划词释义与单段重译。',
    permissions: [
      'storage',
      'activeTab',
      'contextMenus',
      'declarativeNetRequest',
    ],
    host_permissions: ['<all_urls>'],
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
  },
});
