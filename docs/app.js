/* Minimal client-side renderer for docs/data/posts.json */

const POSTS_URL = './data/posts.json';
const META_URL = './data/meta.json';
const Common = window.Common;
const { el, normalizeHashtag } = Common;

const state = {
  posts: [],
  filtered: [],
  pageSize: 30,
  rendered: 0,
  query: '',
  filter: 'all',
  postIndex: new Map(),
};

function setStatus(text, kind){
  const box = Common.el('status');
  if(!text){
    box.textContent = '';
    box.className = 'status';
    box.style.display = 'none';
    return;
  }
  box.textContent = text;
  box.className = 'status' + (kind ? ' ' + kind : '');
  box.style.display = '';
}

function formatLocalDate(iso){
  if(!iso) return '—';
  try{
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }catch(e){
    return iso;
  }
}

function postHasMedia(p){
  return Array.isArray(p.media) && p.media.length > 0;
}

function applyFilters(){
  const q = state.query.trim().toLowerCase();
  const mf = state.filter;

  let arr = state.posts;

  if(mf === 'withMedia'){
    arr = arr.filter(p => postHasMedia(p));
  } else if(mf === 'textOnly'){
    arr = arr.filter(p => !postHasMedia(p));
  }

  if(q){
    arr = arr.filter(p => (p.text || '').toLowerCase().includes(q));
  }

  state.filtered = arr;
  state.rendered = 0;
  el('posts').innerHTML = '';
}

function handleHashtagClick(tag){
  const input = el('searchInput');
  const normalized = normalizeHashtag(tag);
  if(!input || !normalized) return;

  input.value = normalized;
  state.query = normalized;
  applyFilters();
  renderNextPage();
  input.focus();
}

function initialQuery(){
  try{
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q') || params.get('search') || params.get('tag');
    return q ? q.trim() : '';
  }catch(e){
    return '';
  }
}

function imagesForPost(post){
  if(!post || !Array.isArray(post.media)) return [];
  return post.media.filter(Common.isImageMedia).map((m) => ({
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

function openLightbox(postId, imageIndex){
  const key = String(postId);
  const post = state.postIndex.get(key) || state.postIndex.get(Number(postId));
  if(!post) return;
  const items = imagesForPost(post);
  if(!items.length) return;
  const idx = Math.max(0, Math.min(imageIndex || 0, items.length - 1));
  lightboxState.postId = postId;
  lightboxState.index = idx;
  lightboxState.items = items;
  showLightbox();
}

function renderNextPage(){
  const container = el('posts');
  const slice = state.filtered.slice(state.rendered, state.rendered + state.pageSize);

  for(const p of slice){
    const card = document.createElement('article');
    card.className = 'post';

    const tgLink = p.link ? `<a href="${Common.escapeHtml(p.link)}" target="_blank" rel="noopener">Открыть в Telegram</a>` : '';
    const permalink = `./post.html?id=${encodeURIComponent(p.id)}`;
    const dateLabel = Common.escapeHtml(formatLocalDate(p.date));
    const actionLinks = [tgLink, `<a href="${permalink}">Открыть пост на сайте</a>`].filter(Boolean).join(' · ');
    const views = (typeof p.views === 'number') ? `${p.views.toLocaleString('ru-RU')} просмотров` : '';
    const reactions = (p.reactions && p.reactions.total) ? `${p.reactions.total.toLocaleString('ru-RU')} реакций` : '';

    const header = `
      <div class="post-header">
        <div class="left"></div>
        <div class="right"><a class="post-date" href="${permalink}">${dateLabel}</a></div>
      </div>
    `;

    const bodyHtml = (p.html && p.html.trim().length > 0)
      ? p.html
      : (p.text ? `<p>${Common.escapeHtml(p.text).replaceAll('\n','<br>')}</p>` : '<p class="muted">[без текста]</p>');

    let mediaHtml = '';
    if(Array.isArray(p.media) && p.media.length){
      let imageIdx = 0;
      const parts = p.media.map((m) => {
        const html = Common.renderMediaItem(m, p.id, Common.isImageMedia(m) ? imageIdx : null);
        if(Common.isImageMedia(m)){
          imageIdx += 1;
        }
        return html;
      }).filter(Boolean);
      if(parts.length){
        mediaHtml = `<div class="media">${parts.join('')}</div>`;
      }
    }

    const actions = `
      <div class="actions">
        <span>${Common.escapeHtml([views, reactions].filter(Boolean).join(' · '))}</span>
        <span class="action-links">${actionLinks}</span>
      </div>
    `;

    card.innerHTML = header + `<div class="post-body">${bodyHtml}${mediaHtml}</div>` + actions;
    Common.linkifyHashtags(card);
    container.appendChild(card);
  }

  state.rendered += slice.length;

  const left = state.filtered.length - state.rendered;
  const btn = el('loadMoreBtn');
  btn.disabled = left <= 0;
  btn.textContent = left > 0 ? `Показать ещё (${left})` : 'Больше нет постов';
}

async function loadAll(){
  setStatus('Загрузка…');

  try{
    const [metaRes, postsRes] = await Promise.all([
      fetch(META_URL, { cache: 'no-store' }),
      fetch(POSTS_URL, { cache: 'no-store' }),
    ]);

    const meta = metaRes.ok ? await metaRes.json() : {};
    const posts = postsRes.ok ? await postsRes.json() : [];

    state.posts = Array.isArray(posts) ? posts : [];
    state.postIndex = new Map(state.posts.map(p => [String(p.id), p]));
    // expected: newest first
    applyFilters();
    renderNextPage();

    // meta UI
    const title = meta.title || 'Telegram Mirror';
    el('siteTitle').textContent = title;
    document.title = title;
    const avatar = el('channelAvatar');
    if(avatar && meta.avatar){
      avatar.src = `./${meta.avatar}`;
      avatar.hidden = false;
      avatar.alt = title;
    } else if(avatar){
      avatar.hidden = true;
    }

    let channelUrl = '#';
    if(meta.username){
      channelUrl = `https://t.me/${meta.username}`;
    } else if(meta.channel){
      const clean = meta.channel.replace(/^@/, '');
      channelUrl = meta.channel.startsWith('http') ? meta.channel : `https://t.me/${clean}`;
    }
    const subscribe = el('subscribeBtn');
    if(subscribe){
      if(channelUrl && channelUrl !== '#'){
        subscribe.href = channelUrl;
        subscribe.hidden = false;
      } else {
        subscribe.hidden = true;
      }
    }

    // repo link (best effort)
    if(location.hostname.endsWith('github.io')){
      const user = location.hostname.split('.')[0];
      const repo = location.pathname.replaceAll('/', '').trim();
      if(user && repo){
        el('repoLink').href = `https://github.com/${user}/${repo}`;
        el('repoLink').textContent = 'GitHub';
      }else{
        el('repoLink').href = '#';
      }
    } else {
      el('repoLink').href = '#';
    }

    setStatus('', 'notice-ok');
  }catch(err){
    console.error(err);
    setStatus('Ошибка загрузки данных. Проверьте, что docs/data/posts.json доступен и валиден.', 'notice-bad');
  }
}

function bindUI(){
  const themeBtn = Common.el('themeToggle');
  if(themeBtn){
    themeBtn.addEventListener('click', () => Common.toggleTheme());
  }

  Common.el('searchInput').addEventListener('input', (e) => {
    state.query = e.target.value || '';
    applyFilters();
    renderNextPage();
  });

  Common.el('loadMoreBtn').addEventListener('click', () => renderNextPage());

  Common.el('posts').addEventListener('click', (e) => {
    const target = e.target;
    const tagNode = target && typeof target.closest === 'function' ? target.closest('.hashtag') : null;
    if(tagNode){
      e.preventDefault();
      handleHashtagClick(tagNode.getAttribute('data-tag') || tagNode.textContent);
      return;
    }
    if(target && target.classList && target.classList.contains('media-img')){
      const postId = target.getAttribute('data-post-id');
      const idx = Number(target.getAttribute('data-image-index') || 0);
      const post = state.postIndex.get(String(postId)) || state.postIndex.get(Number(postId));
      Common.openLightboxForPost(post, Number.isNaN(idx) ? 0 : idx);
    }
  });
}

Common.initTheme();
bindUI();
const seededQuery = initialQuery();
if(seededQuery){
  const input = Common.el('searchInput');
  if(input) input.value = seededQuery;
  state.query = seededQuery;
}
loadAll();
