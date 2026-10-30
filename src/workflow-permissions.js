// These permissions come only from the server's local startup configuration.
// A workflow definition or MCP tool argument cannot grant them to itself.
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw Object.assign(new Error(code + '：' + message), {code}); };

export function normalizeWorkflowPermissions(value = {}) {
  if (!plain(value) || Object.keys(value).some(key => !['allowWrite', 'allowWriteLearning'].includes(key))) {
    fail('WORKFLOW_PERMISSIONS_INVALID', '权限只接受 allowWrite 和 allowWriteLearning');
  }
  const permissions = {};
  for (const key of ['allowWrite', 'allowWriteLearning']) {
    const values = Object.hasOwn(value, key) ? value[key] : [];
    if (!Array.isArray(values) || values.length > 100 || values.some(id => typeof id !== 'string' || !ID.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id))) {
      fail('WORKFLOW_PERMISSIONS_INVALID', '权限需要明确的 workflow id 数组');
    }
    permissions[key] = [...new Set(values)].sort();
  }
  if (permissions.allowWriteLearning.some(id => !permissions.allowWrite.includes(id))) {
    fail('WORKFLOW_PERMISSIONS_INVALID', '学习许可必须同时具备执行许可');
  }
  return permissions;
}

export function assertWorkflowPermission(value, id, {learning = false} = {}) {
  const permissions = normalizeWorkflowPermissions(value);
  const denied = (code, message) => { try { fail(code, message); } catch (error) { error.writeOutcome = {status:'not_started', automaticRetry:false}; throw error; } };
  if (!permissions.allowWrite.includes(id)) denied('WORKFLOW_WRITE_NOT_APPROVED', '启动配置未批准此 workflow 写入');
  if (learning && !permissions.allowWriteLearning.includes(id)) denied('WORKFLOW_WRITE_LEARNING_NOT_APPROVED', '启动配置未批准实际写入学习样本');
}
