import { Database } from './src/index.js';

// 基础示例：定义模型并完成增删改查
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

(async () => {
  const db = new Database(':memory:');

  const User = db.model('User', {
    tableName: 'users',
    fields: {
      name: 'TEXT',
      age: 'INTEGER',
      email: 'TEXT',
    },
  });

  // 新增：返回包含自增 id 与自动时间戳的完整记录
  const user = User.create({
    name: '张三',
    age: 25,
    email: 'zhangsan@example.com',
  });
  console.log('created:', user);

  User.create({ name: '李四', age: 25, email: 'lisi@example.com' });
  User.create({ name: "O'Brien \"q\"; DROP TABLE users; --", age: 30, email: "o'brien@example.com" });

  // 查询
  console.log('findById(1):', User.findById(1));
  console.log('findMany({ age: 25 }):', User.findMany({ age: 25 }));
  console.log('findMany():', User.findMany().length, 'rows (default order: id DESC)');
  console.log('count():', User.count());
  console.log('count({ age: 25 }):', User.count({ age: 25 }));

  // 排序与分页：按 name 升序取前 2 条
  console.log(
    'findMany(undefined, { orderBy: "name", order: "ASC", limit: 2 }):',
    User.findMany(undefined, { orderBy: 'name', order: 'ASC', limit: 2 }).map((u) => u.name),
  );

  // 关键字搜索：默认搜索全部 TEXT 字段（ASCII 大小写不敏感）
  console.log('search("zhang"):', User.search('zhang').map((u) => u.name));
  // 指定字段 + 排序分页
  console.log(
    'search("example", { fields: ["name", "email"], orderBy: "name", order: "ASC", limit: 2 }):',
    User.search('example', { fields: ['name', 'email'], orderBy: 'name', order: 'ASC', limit: 2 }).map(
      (u) => u.name,
    ),
  );
  // 搜索结果总数（用于分页）
  console.log('count(undefined, { keyword: "example" }):', User.count(undefined, { keyword: 'example' }));

  // 修改：只更新传入的字段；updatedAt 自动刷新、createdAt 保持不变
  await sleep(5); // 等待时钟前进，确保时间戳变化可见
  console.log('update(1, { age: 26 }):', User.update(1, { age: 26 }));
  console.log('after update:', User.findById(1));

  // 删除
  console.log('delete(1):', User.delete(1));
  console.log('findById(1) after delete:', User.findById(1));

  // 关闭数据库
  db.close();
  console.log('database closed, isOpen =', db.isOpen);
})();
