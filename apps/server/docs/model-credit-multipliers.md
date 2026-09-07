# 模型独立积分系数

供应商与模型配置为每个模型保存独立的积分系数，默认值为 1。系数可填写 0.000001～1000，最多 6 位小数。积分定价页面不再提供按模型类型共享的系数配置。

## 计费规则

- 文本生成、视频理解：模型消耗积分数 × 该模型系数。
- 图片生成：所选分辨率每次消耗积分数 × 该模型系数。
- 视频生成：所选分辨率每秒消耗积分数 × 该模型系数 × 视频秒数。

例如图片消耗积分为 3、模型系数为 1.5，最终每次扣 4.5 积分；视频消耗积分为 2/秒、模型系数为 1.5，生成 10 秒最终扣 30 积分。小数积分按账本精度保留 6 位，超出部分向上取到 0.000001 积分。

迁移 `036_provider_model_credit_multiplier.sql` 在 `provider_models` 增加 `credit_multiplier`，已有模型使用默认值 1。创建或编辑模型时通过供应商模型接口一并保存系数，修改记录写入原有模型审计日志。

人民币比例和实时自动定价只更新模型或分辨率的基础消耗积分，不把系数写回基础价，因此反复同步不会叠乘。实时同步会在启用、当前 API Key 可用且可换算的渠道中选择最低价格，再按人民币/积分比例向上换算；无法换算的 Token 报价保留原积分。

客户端模型目录的 `credit_cost` 与 `resolution_prices[].credit_cost` 是乘系数后的最终单价，同时返回 `base_credit_cost` 和 `credit_multiplier`。后台模型目录保留可编辑的基础 `credit_cost`，并返回 `final_credit_cost` 供预览。

服务端创建任务时从所选模型读取系数，按最终积分检查余额并预扣；客户端请求中的自定义积分或系数不能覆盖。任务保存最终 `estimated_credits`，成功结算沿用该锁定值，不会在结算时读取新系数或再次相乘。

## 验证

```bash
npm run test:multipliers --workspace @aivs/server
npm run test:credit-confirmation --workspace @aivs/server
npm run test:pricing --workspace @aivs/server
```
