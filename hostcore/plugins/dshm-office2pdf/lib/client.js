/**
 * dshm-office2pdf 客户端半边 —— **刻意不注册任何东西**。
 *
 * 【为什么留空壳】`package.json` 声明了 `dsh.client`（浏览器半边），删掉导出会让装配期报
 * "declares dsh.client but exports no ./client bundle"，所以保留本文件但不做事。
 *
 * 【为什么不做 UI】正文渲染完全交给官方 `dsh-client-ui-sidebar-documentpreview` 的 office
 * 实现（它调 `remote.officeToPdf`，而该服务由本插件宿主半边顶替成 HAP 内置 office2pdf）。
 *
 * 【2026-10-29 教训 —— 为什么工具栏按钮被撤掉】尝试在
 * `sidebar.right.tab.document.action` 槽里按预览实现 id 注册"用其他应用打开"按钮时，
 * 触发 **documentpreview 插件激活失败**（页面报 `Failed to load plugins: …failed /
 * web boot: 1 entry did not activate`，整个 GUI 起不来）。该 keyed 槽与上游自己的条目
 * 存在冲突，插件侧注册会让上游插件激活异常。
 * ⇒ 该按钮若要重做，必须换机制（例如 list 槽 + 与上游不冲突的 key，或由 HAP 侧出图），
 *    并先在离线环境验证槽位注册不会抛错。备份见 `/tmp/o2p-button-wip/client.js.button-attempt`。
 *
 * @module dshm-office2pdf/client
 */
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dshm-office2pdf",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** 不依赖任何客户端服务。 */
		const inject = [];
		exports.inject = inject;

		/** 客户端没有行为。 */
		function apply() {}
		exports.apply = apply;

		return module.exports;
	},
});
