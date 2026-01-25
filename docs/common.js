(() => {
  const THEME_STORAGE_KEY = 'tg-theme';
  const HASHTAG_RE = /#([\p{L}\p{N}_]+)/gu;
  const lightboxState = { postId: null, index: 0, items: [] };

  function el(id){ return document.getElementById(id); }

  function getPreferredTheme(){
    let stored = '';
    try{
      stored = (localStorage.getItem(THEME_STORAGE_KEY) || '').toLowerCase();
    }catch(e){
      stored = '';
    }
    if(stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(theme){
    const t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    if(document.body){
      document.body.setAttribute('data-theme', t);
    }
    const btn = el('themeToggle');
    if(btn){
      const label = t === 'dark' ? 'Светлая тема' : 'Тёмная тема';
      btn.textContent = t === 'dark' ? '☾' : '☀';
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
  }

  function initTheme(){
    applyTheme(getPreferredTheme());

    if(window.matchMedia){
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = (e) => {
        try{
          if(localStorage.getItem(THEME_STORAGE_KEY)) return;
        }catch(err){}
        applyTheme(e.matches ? 'dark' : 'light');
      };
      if(typeof mq.addEventListener === 'function'){
        mq.addEventListener('change', handler);
      } else if(typeof mq.addListener === 'function'){
        mq.addListener(handler);
      }
    }
  }

  function toggleTheme(){
    const current = document.documentElement.getAttribute('data-theme') || getPreferredTheme();
    const next = current === 'dark' ? 'light' : 'dark';
    try{
      localStorage.setItem(THEME_STORAGE_KEY, next);
    }catch(e){}
    applyTheme(next);
  }

  function escapeHtml(s){
    return (s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function normalizeHashtag(tag){
    const t = (tag || '').trim();
    if(!t) return '';
    return t.startsWith('#') ? t : '#' + t;
  }

  function linkifyHashtags(root){
    if(!root || typeof document === 'undefined') return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const targets = [];
    let node;
    while((node = walker.nextNode())){
      if(!node.nodeValue || !node.nodeValue.includes('#')) continue;
      if(node.parentElement && node.parentElement.closest('a')) continue;
      targets.push(node);
    }

    for(const textNode of targets){
      const text = textNode.nodeValue;
      HASHTAG_RE.lastIndex = 0;
      let match;
      let lastIndex = 0;
      let replaced = false;
      const frag = document.createDocumentFragment();

      while((match = HASHTAG_RE.exec(text))){
        const start = match.index;
        if(start > lastIndex){
          frag.append(text.slice(lastIndex, start));
        }
        const tag = match[0];
        const clean = match[1];
        const a = document.createElement('a');
        a.className = 'hashtag';
        a.textContent = tag;
        a.href = '#';
        a.setAttribute('data-tag', clean);
        frag.append(a);
        lastIndex = start + tag.length;
        replaced = true;
      }

      if(!replaced) continue;
      if(lastIndex < text.length){
        frag.append(text.slice(lastIndex));
      }

      if(textNode.parentNode){
        textNode.parentNode.replaceChild(frag, textNode);
      }
    }
  }

  function looksLikeImage(path, mime){
    const p = (path || '').toLowerCase();
    if(mime && mime.startsWith('image/')) return true;
    return p.endsWith('.jpg') || p.endsWith('.jpeg') || p.endsWith('.png') || p.endsWith('.gif') || p.endsWith('.webp');
  }

  function isImageMedia(m){
    if(!m) return false;
    if(m.kind === 'photo' || m.kind === 'image') return true;
    return looksLikeImage(m.path, m.mime);
  }

  function renderMediaItem(m, postId, imageIndex){
    if(!m || !m.path) return '';
    const path = escapeHtml(m.path);
    const mime = m.mime || '';
    const name = m.name || path.split('/').pop();

    if(isImageMedia(m)){
      const idxAttr = (imageIndex ?? '') !== '' ? ` data-image-index="${imageIndex}"` : '';
      return `<img class="media-img" loading="lazy" src="./${path}" alt="" data-post-id="${postId}"${idxAttr} />`;
    }

    if(m.kind === 'video'){
      return `<video controls preload="metadata" src="./${path}"></video>`;
    }
    if(m.kind === 'audio'){
      return `<audio controls preload="metadata" src="./${path}"></audio>`;
    }

    if(m.kind === 'document'){
      if(looksLikeImage(path, mime)){
        return `<img loading="lazy" src="./${path}" alt="" />`;
      }
      return `<a class="badge" href="./${path}" target="_blank" rel="noopener">Скачать: ${escapeHtml(name || 'файл')}</a>`;
    }

    return `<img class="media-img" loading="lazy" src="./${path}" alt="" data-post-id="${postId}"${(imageIndex ?? '') !== '' ? ` data-image-index="${imageIndex}"` : ''} />`;
  }

  function imagesForPost(post){
    if(!post || !Array.isArray(post.media)) return [];
    return post.media.filter(isImageMedia).map((m) => ({
      src: `./${m.path}`,
      alt: m.name || '',
    }));
  }

  function ensureLightbox(){
    let lb = document.getElementById('lightbox');
    if(lb) return lb;
    lb = document.createElement('div');
    lb.id = 'lightbox';
    lb.className = 'lightbox';
    lb.innerHTML = `
      <div class="lightbox-inner">
        <button class="lightbox-btn lightbox-close" type="button" aria-label="Закрыть">✕</button>
        <div class="lightbox-nav">
          <button class="lightbox-btn lightbox-prev" type="button" aria-label="Предыдущее">‹</button>
          <button class="lightbox-btn lightbox-next" type="button" aria-label="Следующее">›</button>
        </div>
        <img id="lightboxImage" alt="" />
        <div class="lightbox-counter" id="lightboxCounter"></div>
      </div>
    `;
    document.body.appendChild(lb);

    lb.addEventListener('click', (e) => {
      if(e.target === lb) closeLightbox();
    });
    lb.querySelector('.lightbox-close')?.addEventListener('click', () => closeLightbox());
    lb.querySelector('.lightbox-prev')?.addEventListener('click', () => stepLightbox(-1));
    lb.querySelector('.lightbox-next')?.addEventListener('click', () => stepLightbox(1));
    document.addEventListener('keydown', onLightboxKey);
    return lb;
  }

  function onLightboxKey(e){
    const lb = document.getElementById('lightbox');
    if(!lb || !lb.classList.contains('visible')) return;
    if(e.key === 'Escape'){ closeLightbox(); }
    else if(e.key === 'ArrowLeft'){ stepLightbox(-1); }
    else if(e.key === 'ArrowRight'){ stepLightbox(1); }
  }

  function showLightbox(){
    const lb = ensureLightbox();
    const img = document.getElementById('lightboxImage');
    const counter = document.getElementById('lightboxCounter');
    const item = lightboxState.items[lightboxState.index];
    if(!item){
      closeLightbox();
      return;
    }
    img.src = item.src;
    img.alt = item.alt || '';
    if(counter){
      counter.textContent = `${lightboxState.index + 1} / ${lightboxState.items.length}`;
    }
    lb.classList.add('visible');
  }

  function closeLightbox(){
    const lb = document.getElementById('lightbox');
    if(lb){
      lb.classList.remove('visible');
    }
    lightboxState.postId = null;
    lightboxState.index = 0;
    lightboxState.items = [];
  }

  function stepLightbox(delta){
    if(!lightboxState.items.length) return;
    lightboxState.index = (lightboxState.index + delta + lightboxState.items.length) % lightboxState.items.length;
    showLightbox();
  }

  function openLightboxForPost(post, imageIndex){
    if(!post) return;
    const items = imagesForPost(post);
    if(!items.length) return;
    const idx = Math.max(0, Math.min(imageIndex || 0, items.length - 1));
    lightboxState.postId = post.id;
    lightboxState.index = idx;
    lightboxState.items = items;
    showLightbox();
  }

  window.Common = {
    el,
    getPreferredTheme,
    applyTheme,
    initTheme,
    toggleTheme,
    escapeHtml,
    normalizeHashtag,
    linkifyHashtags,
    looksLikeImage,
    isImageMedia,
    renderMediaItem,
    imagesForPost,
    ensureLightbox,
    openLightboxForPost,
  };
})();
