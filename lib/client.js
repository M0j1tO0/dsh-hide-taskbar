/**
 * dsh-plugin-taskbar-autohide —— 渲染层半（可选，浏览器模块）。
 *
 * 形态：window.__ModuleLoader__.load({ id, factory })，与宿主半按同名 id 配对，
 * 由 package.json 的 dsh.client 清单声明。没有 import，因此不需要打包器。
 *
 * 它只做一件事：把 F11 接到 HTML5 全屏上。DSH 桌面端的窗口没有绑定任何窗口级全屏
 * 加速键（实测按 F11 无反应），而 Electron 会把 requestFullscreen() 变成真正的
 * OS 全屏 —— 于是任务栏被整块盖住，连把鼠标压到屏幕底边也不会弹出来。
 *
 * 这一半是可选的：宿主半的"自动隐藏"不依赖它，它加载失败也只影响 F11 这个便利键。
 * 所有 DOM 操作都包在 try/catch 里，绝不让它把 GUI 拖垮。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-taskbar-autohide',
  factory: () => {
    const KEY = 'F11'

    function toggleFullscreen() {
      try {
        if (document.fullscreenElement) return document.exitFullscreen()
        const el = document.documentElement
        return el.requestFullscreen ? el.requestFullscreen() : undefined
      } catch (err) {
        try {
          console.warn('[taskbar-autohide/client] 全屏切换失败:', err)
        } catch {}
        return undefined
      }
    }

    function apply(ctx) {
      const onKey = (event) => {
        try {
          if (event.key !== KEY) return
          if (event.ctrlKey || event.altKey || event.metaKey) return
          event.preventDefault()
          void toggleFullscreen()
        } catch {}
      }

      try {
        window.addEventListener('keydown', onKey, true)
      } catch {}

      const teardown = () => {
        try {
          window.removeEventListener('keydown', onKey, true)
        } catch {}
      }

      // 卸载 / HMR：teardown 走 fiber effect，插件自己不能变成泄漏源。
      try {
        if (ctx && typeof ctx.effect === 'function') ctx.effect(() => teardown)
      } catch {}

      try {
        console.debug('[taskbar-autohide/client] 已挂载：F11 切换 OS 全屏')
      } catch {}

      return teardown
    }

    return { apply, inject: [] }
  },
})
