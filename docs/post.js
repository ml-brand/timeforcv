/* Single post view for Telegram mirror */

const POSTS_URL = './data/posts.json';
const META_URL = './data/meta.json';
const Common = window.Common;
const { el, normalizeHashtag } = Common;

const state = {
  posts: [],
  postIndex: new Map(),
  current: null,
};

function setStatus(text, kind){
  const box = el('status');
  if(!box) return;
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

function goToSearch(tag){
  const normalized = normalizeHashtag(tag);
  if(!normalized) return;
  try{
    const base = new URL(window.location.href);
    base.search = '';
    base.hash = '';
    const target = new URL('./', base);
    target.searchParams.set('q', normalized);
    window.location.href = target.toString();
  }catch(e){
    window.location.href = './?q=' + encodeURIComponent(normalized);
  }
}

function openLightboxForId(postId, imageIndex){
  const key = String(postId);
  const post = state.postIndex.get(key) || state.postIndex.get(Number(postId));
  if(!post) return;
  Common.openLightboxForPost(post, imageIndex);
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

function parsePostId(){
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id') || params.get('post');
  if(id && String(id).trim()) return String(id).trim();
  const hash = window.location.hash.replace('#', '').trim();
  return hash || null;
}

function permalinkFor(id){
  try{
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/[^/]+$/, 'post.html');
    url.searchParams.set('id', id);
    return url.toString();
  }catch(e){
    return `./post.html?id=${encodeURIComponent(id)}`;
  }
}

function populateMeta(meta, post){
  const title = meta.title || 'Telegram Mirror';
  el('siteTitle').textContent = title;
  document.title = post ? `${title} — пост #${post.id}` : `${title} — пост`;
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

  // Meta badges removed from header; keep date in body only.
}

function renderPost(post){
  const container = el('postContainer');
  if(!container) return;

  if(!post){
    container.innerHTML = '<p class="muted">Пост не найден. Вернитесь к списку и попробуйте другой идентификатор.</p>';
    return;
  }

  const tgLink = post.link ? `<a href="${Common.escapeHtml(post.link)}" target="_blank" rel="noopener">Открыть в Telegram</a>` : '';
  const views = (typeof post.views === 'number') ? `${post.views.toLocaleString('ru-RU')} просмотров` : '';
  const reactions = (post.reactions && post.reactions.total) ? `${post.reactions.total.toLocaleString('ru-RU')} реакций` : '';
  const permalink = permalinkFor(post.id);
  const dateLink = `<a class="post-date" href="${Common.escapeHtml(permalink)}">${Common.escapeHtml(formatLocalDate(post.date))}</a>`;

  const bodyHtml = (post.html && post.html.trim().length > 0)
    ? post.html
    : (post.text ? `<p>${Common.escapeHtml(post.text).replaceAll('\n','<br>')}</p>` : '<p class="muted">[без текста]</p>');

  let mediaHtml = '';
  if(Array.isArray(post.media) && post.media.length){
    let imageIdx = 0;
    const parts = post.media.map((m) => {
      const html = Common.renderMediaItem(m, post.id, Common.isImageMedia(m) ? imageIdx : null);
      if(Common.isImageMedia(m)){
        imageIdx += 1;
      }
      return html;
    }).filter(Boolean);
    if(parts.length){
      mediaHtml = `<div class="media">${parts.join('')}</div>`;
    }
  }

  const links = [tgLink, `<a href="${Common.escapeHtml(permalink)}">Ссылка на этот пост</a>`].filter(Boolean).join(' · ');
  const actions = `
    <div class="actions">
      <span>${Common.escapeHtml([views, reactions].filter(Boolean).join(' · '))}</span>
      <span class="action-links">${links}</span>
    </div>
  `;

  container.innerHTML = `
    <div class="post-header">
      <div class="right">${dateLink}</div>
    </div>
    <div class="post-body">${bodyHtml}${mediaHtml}</div>
    ${actions}
  `;

  Common.linkifyHashtags(container);
}

function updateNav(post){
  if(!post) return;
  const idx = state.posts.findIndex(p => String(p.id) === String(post.id));
  const newer = idx > 0 ? state.posts[idx - 1] : null;
  const older = idx >= 0 && idx < state.posts.length - 1 ? state.posts[idx + 1] : null;
  setNavLink(el('prevPost'), newer, '← Более новый');
  setNavLink(el('nextPost'), older, 'Более старый →');
}

function setNavLink(node, post, label){
  if(!node) return;
  if(post){
    node.href = `./post.html?id=${encodeURIComponent(post.id)}`;
    node.textContent = label;
    node.classList.remove('disabled');
    node.style.visibility = 'visible';
  } else {
    node.href = '#';
    node.textContent = label;
    node.classList.add('disabled');
    node.style.visibility = 'hidden';
  }
}

async function loadPostPage(){
  setStatus('Загрузка…');
  const targetId = parsePostId();
  if(!targetId){
    setStatus('Не указан идентификатор поста.', 'notice-bad');
    return;
  }

  try{
    const [metaRes, postsRes] = await Promise.all([
      fetch(META_URL, { cache: 'no-store' }),
      fetch(POSTS_URL, { cache: 'no-store' }),
    ]);

    const meta = metaRes.ok ? await metaRes.json() : {};
    const posts = postsRes.ok ? await postsRes.json() : [];

    state.posts = Array.isArray(posts) ? posts : [];
    state.postIndex = new Map(state.posts.map(p => [String(p.id), p]));

    const post = state.postIndex.get(String(targetId)) || state.postIndex.get(Number(targetId));
    state.current = post || null;

    populateMeta(meta, post);
    renderPost(post);
    updateNav(post);
    setStatus(post ? '' : 'Пост не найден.', post ? 'notice-ok' : 'notice-bad');

    // repo link (best effort)
    if(location.hostname.endsWith('github.io')){
      const user = location.hostname.split('.')[0];
      const parts = location.pathname.split('/').filter(Boolean);
      const repo = parts[0] || '';
      if(user && repo){
        el('repoLink').href = `https://github.com/${user}/${repo}`;
        el('repoLink').textContent = 'GitHub';
      }else{
        el('repoLink').href = '#';
      }
    } else {
      el('repoLink').href = '#';
    }
  }catch(err){
    console.error(err);
    setStatus('Ошибка загрузки данных. Проверьте, что docs/data/posts.json доступен и валиден.', 'notice-bad');
  }
}

function bindUI(){
  const themeBtn = el('themeToggle');
  if(themeBtn){
    themeBtn.addEventListener('click', () => Common.toggleTheme());
  }
  const container = el('postContainer');
  if(container){
    container.addEventListener('click', (e) => {
      const target = e.target;
      const tagNode = target && typeof target.closest === 'function' ? target.closest('.hashtag') : null;
      if(tagNode){
        e.preventDefault();
        goToSearch(tagNode.getAttribute('data-tag') || tagNode.textContent);
        return;
      }
      if(target && target.classList && target.classList.contains('media-img')){
        const postId = target.getAttribute('data-post-id');
        const idx = Number(target.getAttribute('data-image-index') || 0);
        openLightboxForId(postId, Number.isNaN(idx) ? 0 : idx);
      }
    });
  }
}

Common.initTheme();
bindUI();
loadPostPage();
