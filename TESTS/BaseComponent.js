export default class BaseComponent {
  #element = null;
  #children = [];
  #parent = null;
  #listeners = [];

  constructor({ element = 'div', namespace, parent, ...rest }) {
    if (!element) {
      throw new Error('Provide a valid `element`.');
    }

    this.createElement(element, namespace);
    if (parent) this.#parent = parent;

    // Автоматический вызов setX для props
    Object.entries(rest).forEach(([key, value]) => {
      const method = `set${key[0].toUpperCase()}${key.slice(1)}`;
      if (typeof this[method] === 'function') {
        this[method](value);
      }
    });
  }

  // === GETTERS ===
  get element() {
    return this.#element;
  }
  get children() {
    return this.#children;
  }
  get parent() {
    return this.#parent;
  }
  get root() {
    return this.#parent ? this.#parent.root : this;
  }

  // === CREATION ===
  createElement(element, namespace) {
    this.#element = namespace
      ? document.createElementNS(namespace, element)
      : document.createElement(element);
    return this.#element;
  }

  // === LISTENERS ===
  setListeners(listeners) {
    const entries = Object.entries(listeners);
    entries.forEach(([event, handler]) => {
      this.#element?.addEventListener(event, handler);
      this.#listeners.push({ event, handler });
    });
    return this;
  }

  removeListeners() {
    this.#listeners.forEach(({ event, handler }) =>
      this.#element?.removeEventListener(event, handler)
    );
    this.#listeners = [];
    return this;
  }

  // === CLASSES ===
  setClasses(classes) {
    this.#element?.classList.add(...this.#normalizeArray(classes));
    return this;
  }

  removeClasses(classes) {
    this.#element?.classList.remove(...this.#normalizeArray(classes));
    return this;
  }

  toggleClasses(classes) {
    this.#normalizeArray(classes).forEach((cls) => {
      this.#element?.classList.toggle(cls);
    });
    return this;
  }

  // === ATTRIBUTES ===
  setAttributes(attributes) {
    if (!attributes) return this;
    Object.entries(attributes).forEach(([key, value]) => {
      if (value === false || value === null || value === undefined) {
        this.#element.removeAttribute(key);
      } else {
        this.#element.setAttribute(key, value);
      }
    });
    return this;
  }

  // === CHILDREN ===
  setChildren(children) {
    const fragment = document.createDocumentFragment();
    children.forEach((child) => {
      fragment.appendChild(child.element);
      this.#children.push(child);
      child.#parent = this;
    });
    this.#element.appendChild(fragment);
    return this;
  }

  setChild(child) {
    this.#element.append(child.element);
    this.#children.push(child);
    child.#parent = this;
    return this;
  }

  removeChild(child) {
    const index = this.#children.indexOf(child);
    if (index !== -1) {
      child.remove();
      this.#children.splice(index, 1);
    }
    return this;
  }

  // === CONTENT ===
  setContent(content) {
    if (typeof content === 'string' || typeof content === 'number') {
      this.#element.textContent = content;
    } else if (content instanceof Node) {
      this.#element.textContent = '';
      this.#element.appendChild(content);
    }
    return this;
  }

  // === SHORTCUT SETTERS ===
  setId(id) {
    this.#element.id = id;
    return this;
  }
  setTitle(title) {
    this.#element.title = title;
    return this;
  }
  setSrc(src) {
    this.#element.src = src;
    return this;
  }
  setHref(href) {
    this.#element.href = href;
    return this;
  }
  setType(type) {
    this.#element.type = type;
    return this;
  }
  setAlt(alt) {
    this.#element.alt = alt;
    return this;
  }
  setName(name) {
    this.#element.name = name;
    return this;
  }
  setPlaceholder(p) {
    this.#element.placeholder = p;
    return this;
  }

  // === SEARCH ===
  findParent(className) {
    let current = this.parent;
    while (current) {
      if (current.constructor.name === className) return current;
      current = current.parent;
    }
    return null;
  }

  findChild(className) {
    for (const child of this.#children) {
      if (child.constructor.name === className) return child;
      const found = child.findChild(className);
      if (found) return found;
    }
    return null;
  }

  // === LIFECYCLE ===
  onMount() {}
  onUnmount() {}

  remove() {
    // 1. Удаляем слушатели
    this.removeListeners();

    // 2. Снимаем подписки от Store
    if (Array.isArray(this.unsubscribes)) {
      this.unsubscribes.forEach((u) => typeof u === 'function' && u());
      this.unsubscribes = null;
    }

    // 3. Удаляем детей ДО удаления DOM
    const children = [...this.children]; // через публичный геттер
    this.#children = [];
    children.forEach((child) => child.remove());

    // 4. Единственный вызов onUnmount()
    this.onUnmount?.();

    // 5. Удаляем DOM
    if (this.#element?.parentNode) {
      this.#element.parentNode.removeChild(this.#element);
    }

    // 6. Удаляем себя из родителя
    if (this.#parent) {
      const index = this.#parent.children.indexOf(this);
      if (index !== -1) {
        this.#parent.children.splice(index, 1);
      }
    }

    // 7. Обнуляем ссылки
    this.#parent = null;
    this.#element = null;
  }

  // === VISIBILITY ===

  show() {
    this.removeClasses('hidden');
    this.setClasses('visible');
  }

  hide() {
    this.removeClasses('visible');
    this.setClasses('hidden');
  }

  toggle() {
    if (this.element.classList.contains('hidden')) {
      this.show();
    } else {
      this.hide();
    }
  }

  // === UTILS ===
  #normalizeArray(value) {
    return Array.isArray(value) ? value : [value];
  }
}
