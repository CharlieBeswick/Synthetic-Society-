export const validationError = 'Provide an agent name (1–80 characters) and message (1–2,000 characters). Blank values and unsupported control characters are not accepted.';
export function validMessage(agent_name, message) {
  return typeof agent_name === 'string' && typeof message === 'string' && agent_name.trim().length >= 1 && agent_name.length <= 80 && message.trim().length >= 1 && message.length <= 2000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(agent_name + message);
}
