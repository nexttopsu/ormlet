/**
 * 内部工具：只被 `database.ts` / `model.ts` 使用，不从包入口导出。
 */

/**
 * 把实例上的内部状态改成不可枚举的自有属性。
 *
 * TypeScript 的 `private` 只在编译期生效，运行期仍是普通的可枚举属性：
 * `Object.keys(instance)` / `JSON.stringify(instance)` 会把连接、数据库路径、
 * 字段表这些内部结构一并输出。模型或数据库实例被写进日志、被当作接口返回值时，
 * 数据库文件路径就跟着泄露了——这与「错误信息不回显路径 / schema」的设计目标冲突。
 */
export function hideInternalState(target: object, keys: readonly string[]): void {
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor === undefined) continue;
    Object.defineProperty(target, key, { ...descriptor, enumerable: false });
  }
}
