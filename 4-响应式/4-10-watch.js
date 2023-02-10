/**
 * @title watch
 * 立即执行的watch 和 回调执行时机
 * 
 * 1. 立即执行：默认情况下，watch的回调只在响应式数据发生变化时执行，
 * 通过可选参数 immediate 来指定回调是否需要立即执行， 实际上立即执行和后续执行没什么区别，
 * 所以将调度函数封装成通用函数，分别在初始时和变更时执行即可
 * 2. 执行时机： 通过一个选项参数 flush 执行 回调函数 的执行时机，本质上时指定 调度函数 的执行时机
 * ① flush 值为 post 时，代表调度函数将副作用函数放进了一个微任务队列里，并等待DOM更新结束后执行
 * ② flush 值为 pre 的情况，涉及组件更新时机，此处无法模拟
 * 
 * （pre 与 post 原义指的是 组件更新前 和 组件更新后）
 */

// 存储副作用函数的桶, 收集副作用
const bucket = new WeakMap()

// 用一个全局变量存储 被注册的 副作用函数
let activeEffect
// effect栈 数组模拟
let effectStack = []

// effect函数 用于注册副作用函数
function effect(fn, options = {}) {
  const effectFn = () => {
    // 清除依赖集合
    cleanup(effectFn)
    // 调用effect注册副作用函数，将副作用函数复制给activeEffect
    activeEffect = effectFn
    // 调用副作用函数前, 将副作用函数压入栈中
    effectStack.push(effectFn)
    // 执行副作用函数, 并将结果存储到res中
    const res = fn() // 新增
    // 当前副作用函数执行完后, 将当前副作用函数弹出栈中
    effectStack.pop()
    // 把 activeEffect 还原为 之前的值
    activeEffect = effectStack[effectStack.length - 1]
    // 将res 作为effectFn的返回值
    return res // 新增
  }
  // 将options挂载到effecFn上
  effectFn.options = options // 新增代码
  // activeEffect.deps 用来存储所有与该副作用函数有关的依赖集合
  effectFn.deps = []

  // 非lazy的时候 才执行
  if (!options.lazy) {
    // 新增
    // 执行副作用函数
    effectFn()
  }
  // 将副作用函数作为返回值返回
  return effectFn
}

function cleanup(effectFn) {
  for (let i = 0; i < effectFn.deps.length; i++) {
    // 当前副作用函数的依赖集合
    const deps = effectFn.deps[i]
    // 删除当前的副作用函数
    deps.delete(effectFn)
  }
  effectFn.deps.length = 0
}

// 原始数据
const data = {
  foo: 1,
  bar: 2,
}
// 代理数据
const obj = new Proxy(data, {
  // 拦截数据读取
  get(target, key) {
    // 将对应的副作用函数放进桶里
    track(target, key)
    // 返回值
    return target[key]
  },
  // 拦截数据变更
  set(target, key, newVal) {
    // 设置值
    target[key] = newVal
    // 将副作用取出来并执行
    trigger(target, key)
  },
})

// 在 get 拦截函数内调用 track 函数 追踪变化
function track(target, key) {
  // 没有直接return
  if (!activeEffect) return

  // 根据target从桶中取 depsMap，也是Map类型： key --> effects
  // （即target对象中 key 的 effect， 也是一个树结构-map）
  let depsMap = bucket.get(target)
  // 如果不存在，就新建
  if (!depsMap) {
    bucket.set(target, (depsMap = new Map()))
  }

  // 根据 key 再从 depsMap 里取出对应的 副作用函数集合 Set数据结构
  let deps = depsMap.get(key)
  // 如果不存在，就新建一个关联关系
  if (!deps) {
    depsMap.set(key, (deps = new Set()))
  }

  // 最后将当前激活的副作用函数放进集合依赖deps里 （放进了桶里）
  deps.add(activeEffect)

  // deps 是当前target， 当前key，所对应的副作用函数的集合
  // 把他放进activeEffect.deps 中
  activeEffect.deps.push(deps) // 新增
}

// 在 set 拦截函数内调用 trigger 函数  触发变化
function trigger(target, key) {
  // 取出target对应的depsMap:  key --> effects
  let depsMap = bucket.get(target)
  if (!depsMap) return
  // 根据 key 取出 副作用函数集合
  let effects = depsMap.get(key)

  // 重新构建一个Set 避免无限循环
  const effectsToRun = new Set()
  effects &&
    effects.forEach((effectFn) => {
      // 如果trigger触发执行的副作用函数与当前正在执行的副作用函数相同, 则不触发执行
      if (effectFn !== activeEffect) {
        effectsToRun.add(effectFn)
      }
    })

  effectsToRun.forEach((effectFn) => {
    // 如果一个副作用函数存在调度器.则调用调度器来执行副作用函数
    if (effectFn.options.scheduler) {
      effectFn.options.scheduler(effectFn)
    } else {
      effectFn()
    }
  })
}

// 计算属性
function computed(getter) {
  // value用来缓存上一次计算的值
  let value
  // dirty标志, 标识是否需要重新计算, true代表脏, 需要进行再次计算
  let dirty = true

  /**
   * 手动调用trigger和 track原因:
   * 计算属性内部拥有自己的effect 且 是懒执行的, 只有真正读取的时候才会执行
   * 对于getter来说, 里面访问的响应式数据会把computed内部的effect收集为依赖
   * 而把计算属性用在另一个effect里面时, 又产生了effect嵌套, 外层的effect不会被内层的effect中的响应式收集
   * 因此 需要手动调用trigger和 track触发追踪陪与响应
   */
  const effectFn = effect(getter, {
    lazy: true,
    // 添加调度器, 在调度器中将dirty置为true, 即当有值发生变化时, 计算属性需要重新计算
    scheduler() {
      dirty = true
      // 当计算属性依赖的响应式数据变化时, 手动调用trigger 触发响应
      trigger(obj, 'value')
    },
  })
  const obj = {
    // 读取getter时才执行effectFn
    get value() {
      // 只有脏时才计算, 并将值缓存在value中
      if (dirty) {
        value = effectFn()
        // 将dirty置为false, 下一次访问直接读取缓存到value中的值
        dirty = false
      }
      // 当读取value时, 手动调用track收集依赖
      track(obj, 'value')
      return value
    },
  }
  return obj
}

// 硬编码只能观测一个属性的变化， 为更具通用性，封装了traverse读取每一个属性
// function watch(source, cb) {
//   effect(
//     () => source.foo,
//     {
//       scheduler() {
//         cb()
//       }
//     }
//   )
// }


// * watch
function watch(source, cb, options = {}) {
  // 定义getter
  let getter
  // 如果 source 是函数， 说明用户传递的是getter，直接赋值
  if (typeof source === 'function') {
    getter = source
  } else {
    // 否则按原来调用递归读取
    getter = () => traverse(source)
  }

  // * 提取 scheduler 调度函数 为 一个独立的 job 函数
  const job = () => {
    // 在scheduler中重新执行副作用函数，得到新值
    newValue = effectFn()
    // 旧值和新值作为回调函数都参数
    cb(newValue, oldValue)
    // 使用新值更新旧值，否则下一次的旧值是错的
    oldValue = newValue
  }

  // 定义新值和旧值
  let newValue, oldValue

  // 使用effect注册副作用函数时，开启lazy选项，并把返回值存到effectFn中，
  const effectFn = effect(
    // 执行getter
    () => getter(source),
    {
      // 使用懒执行 并手动调用effectFn，返回值就是旧值 也是第一次执行得到的值
      lazy: true,
      // 使用 job 作为调度器函数， job函数内容就是原来调度器函数的内容 没有变化
      scheduler: () => {
        // 在调度中判断flush是否为post 如果是，就放进微任务里执行
        if (options.flush === 'post') {
          const p = Promise.resolve()
          p.then(job)
        } else {
          job()
        }
      },
    }
  )

  if (options.immediate) {
    // immediate 为 true 时，立即执行调度器函数。 从而触发回调执行
    // 由于第一次回调执行时没有所谓的旧值， 所以此时回调的oldValue 为 undefined
    job()
  } else {
    // 手动调用副作用函数，拿到的值就是旧值
    oldValue = effectFn()
  }
    
}

// 递归读取代替硬编码的方式，可以读取对象上每一个属性，这样，任意属性变化都能触发回调函数执行
function traverse(value, seen = new Set()) {
  // 如果读取的是原始值，或者已经被读取过了，什么都不做
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  // 将数据添加到seen中，代表遍历读取过了，避免循环引用引起死循环
  seen.add(value)
  // 暂不考虑数组等其他数据结构
  // 假设value是一个对象，使用循环读取每一个值并递归调用traverse处理
  for (const k in value) {
    traverse(value[k], seen)
  }
  return value
}

// watch 观测响应式数据
watch(obj, () => {
  console.log('obj changed')
}, { immediate: true })
// 修改响应数据的值，会导致回调函数执行
obj.foo++

// watch 还可以接收getter函数
watch(
  // getter 函数
  () => obj.foo,
  // 回调函数
  () => {
    console.log('foo changed')
  }, {
    flush: 'post'
  }
)
