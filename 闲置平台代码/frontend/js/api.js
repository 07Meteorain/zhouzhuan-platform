/* =====================================================================
   api.js —— 统一 API 调用封装
   ---------------------------------------------------------------------
   职责：
     - 统一携带 JWT（Authorization: Bearer <token>）
     - 统一解析 JSON / 错误信息，失败时抛出可读中文提示
     - 401 自动跳转登录页
   所有页面均通过 window.API 调用后端，不在页面里散落 fetch。
   ===================================================================== */

(function () {
    const TOKEN_KEY = "paip_token";   // public asset idle platform token
    const USER_KEY = "paip_user";

    function getToken() {
        return localStorage.getItem(TOKEN_KEY) || "";
    }

    function setSession(token, user) {
        localStorage.setItem(TOKEN_KEY, token);
        localStorage.setItem(USER_KEY, JSON.stringify(user || {}));
    }

    function clearSession() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
    }

    function getUser() {
        try {
            return JSON.parse(localStorage.getItem(USER_KEY) || "{}");
        } catch (e) {
            return {};
        }
    }

    /**
     * 核心请求方法
     * @param {string} path  以 /api 开头的接口路径
     * @param {object} opt   { method, body, params, form }
     */
    async function request(path, opt) {
        opt = opt || {};
        const method = (opt.method || "GET").toUpperCase();
        const headers = {};
        let url = path;

        if (opt.params) {
            const qs = new URLSearchParams();
            Object.keys(opt.params).forEach(function (k) {
                const v = opt.params[k];
                if (v !== "" && v !== null && v !== undefined) qs.append(k, v);
            });
            const s = qs.toString();
            if (s) url += (url.indexOf("?") >= 0 ? "&" : "?") + s;
        }

        let body;
        if (opt.form) {
            body = opt.form; // FormData，交给浏览器设置 Content-Type
        } else if (opt.body !== undefined) {
            headers["Content-Type"] = "application/json";
            body = JSON.stringify(opt.body);
        }

        const token = getToken();
        if (token) headers["Authorization"] = "Bearer " + token;

        let resp;
        try {
            resp = await fetch(url, { method: method, headers: headers, body: body });
        } catch (e) {
            throw new Error("无法连接后端服务，请确认 docker compose 已启动（后端 8000）");
        }

        if (resp.status === 401) {
            clearSession();
            if (!location.pathname.endsWith("/index.html") && location.pathname !== "/") {
                location.href = "/index.html";
            }
            throw new Error("登录已失效，请重新登录");
        }

        const text = await resp.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch (e) {
            data = text;
        }

        if (!resp.ok) {
            let msg = "请求失败";
            if (data && typeof data === "object" && data.detail) {
                msg = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
            } else if (typeof data === "string" && data) {
                msg = data;
            }
            throw new Error(msg);
        }
        return data;
    }

    window.API = {
        // ---------- 会话 ----------
        getToken: getToken,
        getUser: getUser,
        setSession: setSession,
        clearSession: clearSession,

        login: function (username, password) {
            return request("/api/auth/login", {
                method: "POST",
                body: { username: username, password: password },
            });
        },
        me: function () {
            return request("/api/auth/me");
        },
        logout: function () {
            return request("/api/auth/logout", { method: "POST" });
        },

        // ---------- 组织机构 ----------
        colleges: function () {
            return request("/api/colleges");
        },
        departments: function (collegeId) {
            return request("/api/colleges/" + collegeId + "/departments");
        },
        createCollege: function (data) {
            return request("/api/admin/colleges", { method: "POST", body: data });
        },
        updateCollege: function (id, data) {
            return request("/api/admin/colleges/" + id, { method: "PUT", body: data });
        },
        deleteCollege: function (id) {
            return request("/api/admin/colleges/" + id, { method: "DELETE" });
        },
        createDepartment: function (data) {
            return request("/api/admin/departments", { method: "POST", body: data });
        },
        updateDepartment: function (id, data) {
            return request("/api/admin/departments/" + id, { method: "PUT", body: data });
        },
        deleteDepartment: function (id) {
            return request("/api/admin/departments/" + id, { method: "DELETE" });
        },

        // ---------- 用户 ----------
        listUsers: function (keyword) {
            return request("/api/admin/users", { params: { keyword: keyword } });
        },
        createUser: function (data) {
            return request("/api/admin/users", { method: "POST", body: data });
        },
        updateUser: function (id, data) {
            return request("/api/admin/users/" + id, { method: "PUT", body: data });
        },
        setUserStatus: function (id, status) {
            return request("/api/admin/users/" + id + "/status", {
                method: "POST",
                body: { status: status },
            });
        },

        // ---------- 物资 ----------
        listAssets: function (params) {
            return request("/api/assets", { params: params });
        },
        assetOptions: function () {
            return request("/api/assets/meta/options");
        },
        myAssets: function () {
            return request("/api/assets/mine");
        },
        getAsset: function (id) {
            return request("/api/assets/" + id);
        },
        createAsset: function (form) {
            return request("/api/assets", { method: "POST", form: form });
        },
        updateAsset: function (id, data) {
            return request("/api/assets/" + id, { method: "PUT", body: data });
        },
        unlistAsset: function (id) {
            return request("/api/assets/" + id + "/unlist", { method: "POST" });
        },
        relistAsset: function (id) {
            return request("/api/assets/" + id + "/relist", { method: "POST" });
        },
        addImages: function (id, form) {
            return request("/api/assets/" + id + "/images", { method: "POST", form: form });
        },
        setCover: function (assetId, imageId) {
            return request("/api/assets/" + assetId + "/images/" + imageId + "/cover", {
                method: "PUT",
            });
        },
        setCaption: function (assetId, imageId, caption) {
            return request("/api/assets/" + assetId + "/images/" + imageId + "/caption", {
                method: "PUT",
                body: { caption: caption },
            });
        },
        deleteImage: function (assetId, imageId) {
            return request("/api/assets/" + assetId + "/images/" + imageId, {
                method: "DELETE",
            });
        },

        createClaim: function (data) {
            return request("/api/claims", { method: "POST", body: data });
        },
        listClaims: function (params) {
            return request("/api/claims", { params: params });
        },
        myClaims: function (direction) {
            return request("/api/claims/mine", { params: { direction: direction } });
        },
        revokeClaim: function (id, reason) {
            return request("/api/claims/" + id + "/revoke", {
                method: "POST",
                params: { reason: reason },
            });
        },

        createHandover: function (claimId) {
            return request("/api/handovers", { method: "POST", body: { claim_id: claimId } });
        },
        listHandovers: function (params) {
            return request("/api/handovers", { params: params });
        },
        getHandover: function (no) {
            return request("/api/handovers/" + encodeURIComponent(no));
        },
        logPrint: function (no) {
            return request("/api/handovers/" + encodeURIComponent(no) + "/print", {
                method: "POST",
            });
        },

        // ---------- 管理员：物资 / 日志 / 统计 ----------
        adminListAssets: function (params) {
            return request("/api/admin/assets", { params: params });
        },
        adminUpdateAsset: function (id, data) {
            return request("/api/admin/assets/" + id, { method: "PUT", body: data });
        },
        adminForceOff: function (id, reason) {
            return request("/api/admin/assets/" + id + "/force-off", {
                method: "POST",
                params: { reason: reason },
            });
        },
        adminRelist: function (id) {
            return request("/api/admin/assets/" + id + "/relist", { method: "POST" });
        },
        adminRejectImage: function (assetId, imageId, reason) {
            return request("/api/admin/assets/" + assetId + "/images/" + imageId + "/reject", {
                method: "POST",
                body: { reason: reason },
            });
        },
        adminRestoreImage: function (assetId, imageId) {
            return request("/api/admin/assets/" + assetId + "/images/" + imageId + "/restore", {
                method: "POST",
            });
        },
        logTypes: function () {
            return request("/api/admin/logs/types");
        },
        listLogs: function (params) {
            return request("/api/admin/logs", { params: params });
        },
        statsOverview: function () {
            return request("/api/admin/stats/overview");
        },
        statsAssets: function (params) {
            return request("/api/admin/stats/assets", { params: params });
        },
        statsDepartments: function () {
            return request("/api/admin/stats/departments");
        },
    };
})();
