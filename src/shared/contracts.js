// 主进程 IPC 共享契约:统一的返回结构与错误码。
// 目的:新增/改动的通道统一用 ok()/fail() 构造返回值,渲染层只需判断 r.ok 与 r.error;
// 错误码用于让调用方做机器判断,不替代面向用户的 error 文案。
// 约定说明(阶段1):
//   1. { ok:true, ...data } 表示成功;
//   2. { ok:false, error, code? } 表示失败,error 必须是可直接展示的中文文案;
//   3. code 取自 ERROR_CODES,便于后续阶段分类处理与埋点。
// 存量通道(返回裸数据/裸原始值的那些)本轮不改行为,待阶段2统一。
const ERROR_CODES = {
  E_INVALID_ARG: 'E_INVALID_ARG',     // 入参校验失败
  E_NOT_FOUND: 'E_NOT_FOUND',         // 目标资源不存在
  E_IO: 'E_IO',                       // 本地文件读写失败
  E_NET: 'E_NET',                     // 网络/远端 API 失败
  E_STATE: 'E_STATE',                 // 状态冲突(如正在换图)
  E_ROLLBACK: 'E_ROLLBACK',           // 失败后回滚异常
};

// 成功:data 为对象时展开到顶层,保持与现有渲染层判断(r.ok / r.error / r.detail ...)兼容
function ok(data) {
  return (data && typeof data === 'object' && !Array.isArray(data))
    ? { ok: true, ...data }
    : { ok: true, data };
}

// 失败:error 为面向用户的文案;detail 为原始错误信息(可为空,不得包含密钥)
function fail(error, code, extra) {
  const out = { ok: false, error: String(error || '未知错误') };
  if (code) out.code = code;
  if (extra && typeof extra === 'object') Object.assign(out, extra);
  return out;
}

// 把异常对象转成 fail() 结果,统一兜底 e.message 缺失的情况
function failFrom(err, code, extra) {
  const msg = (err && err.message) ? err.message : String(err || '未知错误');
  return fail(msg, code, extra);
}

module.exports = { ok, fail, failFrom, ERROR_CODES };
