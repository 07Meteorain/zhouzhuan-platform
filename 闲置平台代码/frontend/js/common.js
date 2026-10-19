/* =====================================================================
   common.js —— 页面公共逻辑（鉴权守卫 / 导航 / 提示 / 工具函数）
   ---------------------------------------------------------------------
   每个页面统一调用：
       PAIP.boot({ role: 'user'|'admin', active: 'home', init: function(user){...} })
   流程：
       1. 无 token 直接跳转 /index.html
       2. 调 /api/auth/me 校验会话与角色，角色不符跳转对应首页
       3. 渲染顶部导航（显示“学院 + 下设部门”、姓名、工号）
       4. 执行页面自定义 init(user)
   ===================================================================== */

(function () {
    const USER_LINKS = [
        { key: "home", label: "首页", href: "/user/home.html" },
        { key: "publish", label: "发布物资", href: "/user/publish.html" },
        { key: "browse", label: "平台浏览", href: "/user/browse.html" },
        { key: "records", label: "我的记录", href: "/user/records.html" },
    ];

    const ADMIN_LINKS = [
        { key: "orgs", label: "组织机构", href: "/admin/orgs.html" },
        { key: "users", label: "用户管理", href: "/admin/users.html" },
        { key: "assets", label: "物资管理", href: "/admin/assets.html" },
        { key: "logs", label: "日志中心", href: "/admin/logs.html" },
        { key: "stats", label: "统计报表", href: "/admin/stats.html" },
    ];

    /* ------------------------------- 工具函数 ------------------------------- */

    function escapeHtml(s) {
        if (s === null || s === undefined) return "";
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function qs(name) {
        return new URLSearchParams(location.search).get(name);
    }

    function today() {
        const d = new Date();
        return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
            String(d.getDate()).padStart(2, "0");
    }

    function statusBadge(status) {
        const map = {
            on: '<span class="badge badge-on">上架</span>',
            off: '<span class="badge badge-off">已下架</span>',
            disabled: '<span class="badge badge-disabled">已停用</span>',
            active: '<span class="badge badge-on">启用</span>',
            normal: '<span class="badge badge-info">正常</span>',
            rejected: '<span class="badge badge-disabled">已驳回</span>',
            revoked: '<span class="badge badge-off">已撤销</span>',
        };
        return map[status] || '<span class="badge">' + escapeHtml(status || "-") + "</span>";
    }

    function el(id) {
        return document.getElementById(id);
    }

    /**
     * 带 JWT 的受保护下载（导出接口专用）
     * ------------------------------------------------------------------
     * 后端所有 /api 接口都要求 Authorization: Bearer <token>，
     * 直接用 location.href 跳转不会携带请求头，会被 401 拒绝。
     * 因此统一走 fetch -> Blob -> a[download] 的方式下载。
     * @param {string} path        接口路径，可含查询串
     * @param {string} fallbackName 后端未返回文件名时使用的默认文件名
     */
    function downloadFile(path, fallbackName) {
        return fetch(path, {
            method: "GET",
            headers: { Authorization: "Bearer " + API.getToken() },
        })
            .then(function (resp) {
                if (!resp.ok) {
                    return resp.text().then(function (t) {
                        let msg = "导出失败（HTTP " + resp.status + "）";
                        try {
                            const j = JSON.parse(t);
                            if (j && j.detail) msg = j.detail;
                        } catch (e) {
                            /* 非 JSON 响应时保留默认提示 */
                        }
                        throw new Error(msg);
                    });
                }
                // 从 Content-Disposition 解析文件名（后端可能带中文名，此处主要取扩展名）
                const cd = resp.headers.get("Content-Disposition") || "";
                let filename = fallbackName || "export";
                const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i.exec(cd);
                if (m && m[1]) {
                    try {
                        filename = decodeURIComponent(m[1].trim());
                    } catch (e) {
                        filename = m[1].trim();
                    }
                }
                return resp.blob().then(function (blob) {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    setTimeout(function () {
                        URL.revokeObjectURL(url);
                    }, 1000);
                });
            });
    }

    /** 把查询对象拼成 URL 查询串（跳过空值） */
    function toQuery(params) {
        const q = new URLSearchParams();
        Object.keys(params || {}).forEach(function (k) {
            const v = params[k];
            if (v !== "" && v !== null && v !== undefined) q.append(k, v);
        });
        const s = q.toString();
        return s ? "?" + s : "";
    }

    /* -------------------------------- Toast -------------------------------- */

    function toast(msg, type) {
        let wrap = document.getElementById("toast-wrap");
        if (!wrap) {
            wrap = document.createElement("div");
            wrap.id = "toast-wrap";
            document.body.appendChild(wrap);
        }
        const div = document.createElement("div");
        div.className = "toast toast-" + (type || "info");
        div.textContent = msg;
        wrap.appendChild(div);
        setTimeout(function () {
            if (div.parentNode) div.parentNode.removeChild(div);
        }, 3200);
    }

    /* -------------------------------- 弹窗 -------------------------------- */

    function closeModal() {
        const mask = document.getElementById("modal-mask");
        if (mask) mask.remove();
    }

    function openModal(title, contentHtml, footerHtml) {
        closeModal();
        const mask = document.createElement("div");
        mask.id = "modal-mask";
        mask.className = "modal-mask";
        mask.innerHTML =
            '<div class="modal">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">' +
            '<h3 style="margin:0;font-size:16px;font-weight:700">' + escapeHtml(title) + "</h3>" +
            '<button class="btn btn-outline btn-sm" onclick="PAIP.closeModal()">关闭</button>' +
            "</div>" +
            '<div class="modal-content">' + contentHtml + "</div>" +
            (footerHtml ? '<div class="modal-footer" style="margin-top:16px">' + footerHtml + "</div>" : "") +
            "</div>";
        mask.addEventListener("click", function (e) {
            if (e.target === mask) closeModal();
        });
        document.body.appendChild(mask);
        return mask;
    }

    function confirmBox(title, message, onYes) {
        const content =
            '<p style="margin:0 0 4px">' + escapeHtml(message) + "</p>";
        const footer =
            '<div style="display:flex;gap:8px;justify-content:flex-end">' +
            '<button class="btn btn-outline btn-sm" onclick="PAIP.closeModal()">取消</button>' +
            '<button class="btn btn-danger btn-sm" id="modal-confirm-yes">确认</button>' +
            "</div>";
        openModal(title, content, footer);
        document.getElementById("modal-confirm-yes").onclick = function () {
            closeModal();
            onYes();
        };
    }

    function promptBox(title, label, defaultValue, onOk) {
        const content =
            '<div class="field"><label class="label">' + escapeHtml(label) + "</label>" +
            '<input class="input" id="modal-prompt-input" value="' + escapeHtml(defaultValue || "") + '" /></div>';
        const footer =
            '<div style="display:flex;gap:8px;justify-content:flex-end">' +
            '<button class="btn btn-outline btn-sm" onclick="PAIP.closeModal()">取消</button>' +
            '<button class="btn btn-sm" id="modal-prompt-ok">确定</button>' +
            "</div>";
        openModal(title, content, footer);
        const input = document.getElementById("modal-prompt-input");
        input.focus();
        document.getElementById("modal-prompt-ok").onclick = function () {
            const v = input.value;
            closeModal();
            onOk(v);
        };
    }

    /**
     * 多字段表单弹窗（管理员修正物资等场景）
     * @param {string}   title    弹窗标题
     * @param {Array}    fields   [{name,label,value,type,options,required,readonly,placeholder}]
     * @param {Function} onSubmit 回调，参数为 {字段名: 值}
     */
    function formModal(title, fields, onSubmit) {
        const content =
            '<div class="grid grid-cols-1 md:grid-cols-2 gap-4">' +
            fields
                .map(function (f) {
                    const type = f.type || "text";
                    let input;
                    if (type === "select") {
                        input =
                            '<select class="select" id="fm-' + f.name + '">' +
                            (f.options || [])
                                .map(function (o) {
                                    const val = typeof o === "object" ? o.value : o;
                                    const lab = typeof o === "object" ? o.label : o;
                                    return (
                                        '<option value="' + escapeHtml(val) + '"' +
                                        (String(val) === String(f.value) ? " selected" : "") +
                                        ">" + escapeHtml(lab) + "</option>"
                                    );
                                })
                                .join("") +
                            "</select>";
                    } else if (type === "textarea") {
                        input =
                            '<textarea class="textarea" id="fm-' + f.name + '" rows="2">' +
                            escapeHtml(f.value || "") +
                            "</textarea>";
                    } else {
                        input =
                            '<input class="input" id="fm-' + f.name + '" type="' +
                            (type === "number" ? "number" : "text") + '"' +
                            (type === "number" ? ' min="0"' : "") +
                            ' value="' + escapeHtml(f.value === null || f.value === undefined ? "" : f.value) + '"' +
                            (f.placeholder ? ' placeholder="' + escapeHtml(f.placeholder) + '"' : "") +
                            (f.readonly ? " readonly" : "") +
                            " />";
                    }
                    return (
                        '<div class="field"' + (f.full ? ' style="grid-column:1/-1"' : "") + ">" +
                        '<label class="label">' + escapeHtml(f.label) +
                        (f.required ? ' <span style="color:#dc2626">*</span>' : "") +
                        (f.readonly ? ' <span class="muted" style="font-size:11px">（只读）</span>' : "") +
                        "</label>" + input + "</div>"
                    );
                })
                .join("") +
            "</div>";
        const footer =
            '<div style="display:flex;gap:8px;justify-content:flex-end">' +
            '<button class="btn btn-outline btn-sm" onclick="PAIP.closeModal()">取消</button>' +
            '<button class="btn btn-sm" id="fm-ok">保存</button>' +
            "</div>";
        openModal(title, content, footer);
        document.getElementById("fm-ok").onclick = function () {
            const data = {};
            fields.forEach(function (f) {
                const node = document.getElementById("fm-" + f.name);
                data[f.name] = node ? node.value : "";
            });
            closeModal();
            onSubmit(data);
        };
    }

    /* ------------------------------- 导航渲染 ------------------------------- */

    function renderNav(role, active, user) {
        const links = role === "admin" ? ADMIN_LINKS : USER_LINKS;
        const nav = document.createElement("header");
        nav.className = "app-nav";
        nav.innerHTML =
            '<div class="app-nav-inner">' +
            '<span class="brand">公共资产闲置平台</span>' +
            '<nav class="nav-links">' +
            links
                .map(function (l) {
                    return (
                        '<a class="nav-link ' +
                        (l.key === active ? "active" : "") +
                        '" href="' +
                        l.href +
                        '">' +
                        l.label +
                        "</a>"
                    );
                })
                .join("") +
            "</nav>" +
            '<div class="nav-user">' +
            "<span>" +
            (role === "admin"
                ? "<strong>" + escapeHtml(user.name || "管理员") + "</strong> · 平台管理员"
                : escapeHtml(user.dept_full_name || "-") +
                  " · <strong>" +
                  escapeHtml(user.name || "") +
                  "</strong> · 工号 " +
                  escapeHtml(user.employee_no || "-")) +
            "</span>" +
            '<button class="btn btn-outline btn-sm" id="btn-logout">退出</button>' +
            "</div>" +
            "</div>";
        document.body.insertBefore(nav, document.body.firstChild);
        document.getElementById("btn-logout").onclick = function () {
            API.logout()
                .catch(function () {})
                .then(function () {
                    API.clearSession();
                    location.href = "/index.html";
                });
        };
    }

    /* -------------------------------- 启动 -------------------------------- */

    function boot(opt) {
        opt = opt || {};
        const role = opt.role || "user";
        const active = opt.active || "";

        if (!API.getToken()) {
            location.href = "/index.html";
            return;
        }
        API.me()
            .then(function (user) {
                if (user.role !== role) {
                    location.href = user.role === "admin" ? "/admin/orgs.html" : "/user/home.html";
                    return;
                }
                renderNav(role, active, user);
                if (typeof opt.init === "function") opt.init(user);
            })
            .catch(function (e) {
                API.clearSession();
                location.href = "/index.html";
            });
    }

    window.PAIP = {
        boot: boot,
        toast: toast,
        escapeHtml: escapeHtml,
        qs: qs,
        today: today,
        statusBadge: statusBadge,
        el: el,
        downloadFile: downloadFile,
        toQuery: toQuery,
        openModal: openModal,
        closeModal: closeModal,
        confirmBox: confirmBox,
        promptBox: promptBox,
        formModal: formModal,
    };
})();
