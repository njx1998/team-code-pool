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
        }
    },

    globalData: {
        appName: '组队',
        version: 'v3.4.3',
    },
});
