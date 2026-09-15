/** 每个终端独立排队，前一次写入完成后才能发送下一次输入。 */
export function createTerminalInputQueue() {
  let tail: Promise<void> = Promise.resolve();

  return (operation: () => Promise<void>): Promise<void> => {
    const result = tail.then(operation);
    // 单次失败由调用方处理，不阻塞后续输入，也不留下未处理的队列拒绝。
    tail = result.catch(() => undefined);
    return result;
  };
}
