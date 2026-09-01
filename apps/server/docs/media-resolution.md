# 图片和视频分辨率转发

网关用客户端选择的 `resolution` 查找分辨率价格（忽略大小写），随后独立转换第三方请求参数，不修改客户端输入、幂等请求哈希或积分价格。

## 自动匹配

- 从模型的 `parameter_schema` 读取 `resolution`、`imageSize`、`image_size`，图片模型也读取 `size`。
- 兼容供应商参数数组的 `options`（字符串或 `{label, value}`）和 JSON Schema 的 `properties` / `enum`。
- 忽略大小写查找对应的 **value**，发送供应商定义的原始大小写，不使用 label。例如 `2K → 2k`、`1080P → 1080p`、`720p → 720P`。
- 参数名按协议放置：媒体协议放入 `params`，REST 放在顶层，Gemini 图片放入 `generationConfig.imageConfig.imageSize`，图片 multipart 请求也携带对应参数。
- 当图片接口只提供像素 `size` 选项时，按选项标签中的 1K/2K/4K 档位和画幅选择实际像素尺寸。例如 TT Image 2 的 2K、9:16 对应 `1440x2560`，不是固定使用默认尺寸。
- 已声明的枚举中不存在该分辨率，或该选项标记 `currently_unavailable` 时，在冻结积分和调用供应商之前拒绝请求。不会把 720p 当成 768P，也不会自动降低画质。
- `resolution` 与 `params.resolution` 可以大小写不同，但不能是不同档位。
- 固定输出模型 Omni Flash 10s 的 `default` 代表不传分辨率参数；明确选择的分辨率仍会转发。

## 未声明枚举的接口

不能可靠推断第三方要求的大小写时，默认保留输入值。可在后台“编辑大模型 → 扩展配置 JSON”添加显式映射，优先于参数定义：

```json
{
  "resolution_parameter": "resolution",
  "resolution_mapping": {
    "2K": "2k",
    "4K": "4k",
    "1080P": "1080p"
  }
}
```

`resolution_parameter` 可用值是 `resolution`、`imageSize`、`image_size`，图片模型还可使用 `size`。没有填写时自动使用参数定义中的字段。

像素尺寸接口可按画幅配置值：

```json
{
  "resolution_parameter": "size",
  "resolution_mapping": {
    "2K": { "9:16": "1440x2560", "16:9": "2560x1440" }
  }
}
```

运行不调用供应商、不消耗积分的回归测试：

```shell
npm run test:gateway --workspace @aivs/server
```
