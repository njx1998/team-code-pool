App({
    onLaunch() {
        // ---- 云开发初始化 ----
        // 环境 ID 在云开发控制台概览页可以看到
        if (!wx.cloud) {
            console.error('当前基础库版本过低（需 2.2.3 以上），无法使用云开发');
        } else {
            wx.cloud.init({
                env: 'cloud1-d2ga7pm5qf05ea36e', // 你的云环境 ID
                // traceUser 已关闭：不记录访客明细，减少云端存储占用
            });

            // ---- 每日清理（替代定时触发器）----
            // 微信云数据库没有 TTL 自动过期，已用/下架的码会永久堆积、拖慢 count。
            // 定时触发器要么控制台手动建，要么根本没有入口，所以改成「每台设备每天
            // 首次启动时清理一次」——效果等价，且不需要任何人工配置。
            // purge 只删 14 天前的废弃码，重复调用完全幂等，不会误删可用码。
            const dayKey = new Date().toDateString();
            if (wx.getStorageSync('lastPurgeDay') !== dayKey) {
                wx.setStorageSync('lastPurgeDay', dayKey); // 先落标记，避免同一天反复调用
                wx.cloud.callFunction({ name: 'purge' })
                    .then((r) => {
                        const d = (r.result && r.result.deleted) || 0;
                        if (d) console.log('[purge] 今日清理过期码:', d);
                    })
                    .catch((e) => console.warn('[purge] 清理失败（不影响使用）:', e.message));
            }
        }
    },

    globalData: {
        appName: '组队',
        version: 'v3.4.3',
    },
});
