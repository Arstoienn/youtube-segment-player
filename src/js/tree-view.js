/**
 * The folder tree.
 *
 * A dumb renderer: it owns no state beyond expand/collapse animation
 * bookkeeping. Every render is driven by the view model the host passes in, and
 * every interaction is reported back through `hooks`.
 */
(function () {
  const ClipPlayer = (window.ClipPlayer = window.ClipPlayer || {});

  /**
   * @param {HTMLElement} root - container the tree renders into.
   * @param {object} hooks - { onSelectClip, onToggleFolder, onTogglePlaylist }.
   * @param {object} strings - config.strings, for the empty-state copy.
   */
  ClipPlayer.createTreeView = function createTreeView(root, hooks, strings) {
    if (!root) return null;

    // Which folder the user just clicked open, so only that one animates.
    let pendingExpandId = null;

    const prefersReducedMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

    return { render, renderMessage };

    function renderMessage(message) {
      const empty = document.createElement("div");
      empty.className = "clip-tree-empty";
      empty.textContent = message;
      root.replaceChildren(empty);
    }

    /** @param {object} model - { folders, activeClipId, expandedFolders, expandedPlaylists } */
    function render(model) {
      if (!model.folders?.length) {
        renderMessage(strings.emptyArchive);
        return;
      }

      const fragment = document.createDocumentFragment();
      model.folders.forEach(folder => fragment.appendChild(renderFolder(folder, model)));
      root.replaceChildren(fragment);
    }

    function renderFolder(folder, model) {
      const wrapper = document.createElement("div");
      wrapper.className = "clip-folder";

      const isExpanded = model.expandedFolders.has(folder.id);
      const hasActiveDescendant = folder.playlists.some(playlist =>
        playlistContainsActive(playlist, model.activeClipId)
      );

      const row = createFolderRow(folder.label, isExpanded, 0, hasActiveDescendant);
      row.addEventListener("click", () =>
        handleFolderToggle({
          wrapper,
          expanded: isExpanded,
          folderId: folder.id,
          keepsActiveChild: hasActiveDescendant,
          onToggle: () => hooks.onToggleFolder(folder.id),
        })
      );
      wrapper.appendChild(row);

      // A collapsed folder still renders the branch holding the playing clip,
      // so "where am I?" stays answerable without expanding anything.
      if (isExpanded || hasActiveDescendant) {
        const children = document.createElement("div");
        children.className = "clip-folder-children";

        folder.playlists.forEach(playlist => {
          if (!isExpanded && !playlistContainsActive(playlist, model.activeClipId)) return;
          children.appendChild(renderPlaylist(playlist, model));
        });

        wrapper.appendChild(children);
        maybeAnimateExpand(children, folder.id, hasActiveDescendant);
      }

      return wrapper;
    }

    function renderPlaylist(playlist, model) {
      const wrapper = document.createElement("div");
      wrapper.className = "clip-folder";

      const isExpanded = model.expandedPlaylists.has(playlist.id);
      const hasActiveDescendant = playlistContainsActive(playlist, model.activeClipId);

      const row = createFolderRow(playlist.label, isExpanded, 1, hasActiveDescendant);
      row.addEventListener("click", () =>
        handleFolderToggle({
          wrapper,
          expanded: isExpanded,
          folderId: playlist.id,
          keepsActiveChild: hasActiveDescendant,
          onToggle: () => hooks.onTogglePlaylist(playlist.id),
        })
      );
      wrapper.appendChild(row);

      if (isExpanded || hasActiveDescendant) {
        const children = document.createElement("div");
        children.className = "clip-folder-children";

        if (!playlist.clips.length) {
          const empty = document.createElement("div");
          empty.className = "clip-tree-empty";
          empty.textContent = strings.emptyFolder;
          children.appendChild(empty);
        } else {
          playlist.clips.forEach(clip => {
            if (!isExpanded && clip.id !== model.activeClipId) return;
            children.appendChild(createClipRow(clip, model.activeClipId));
          });
        }

        wrapper.appendChild(children);
        maybeAnimateExpand(children, playlist.id, hasActiveDescendant);
      }

      return wrapper;
    }

    function createFolderRow(label, expanded, depth, hasActiveDescendant) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "clip-folder-row";
      row.dataset.depth = String(depth);
      row.setAttribute("aria-expanded", expanded ? "true" : "false");

      if (hasActiveDescendant) {
        row.classList.add("has-active-descendant");
      }

      row.appendChild(decorativeSpan("clip-folder-caret"));
      row.appendChild(decorativeSpan("clip-folder-icon"));

      const text = document.createElement("span");
      text.className = "clip-folder-label";
      text.textContent = label;
      row.appendChild(text);

      return row;
    }

    function createClipRow(clip, activeClipId) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "clip-file-row";
      row.dataset.clipId = clip.id;
      row.addEventListener("click", () => hooks.onSelectClip(clip.id));

      if (clip.id === activeClipId) {
        row.classList.add("is-active");
        row.setAttribute("aria-current", "true");
      }

      row.appendChild(createThumbnail(clip));

      const label = document.createElement("span");
      label.className = "clip-file-label";
      label.textContent = clip.label;
      row.appendChild(label);

      return row;
    }

    function createThumbnail(clip) {
      if (!clip.thumbnail) return decorativeSpan("clip-file-icon");

      const image = document.createElement("img");
      image.className = "clip-file-thumb";
      image.src = clip.thumbnail;
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      // Thumbnails come straight from i.ytimg.com; don't leak the host page.
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => image.replaceWith(decorativeSpan("clip-file-icon")), {
        once: true,
      });

      return image;
    }

    function decorativeSpan(className) {
      const span = document.createElement("span");
      span.className = className;
      span.setAttribute("aria-hidden", "true");
      return span;
    }

    function playlistContainsActive(playlist, activeClipId) {
      return Boolean(activeClipId) && playlist.clips.some(clip => clip.id === activeClipId);
    }

    // --- expand / collapse animation -----------------------------------------
    //
    // Rendering is synchronous, so a collapse has to finish animating *before*
    // the re-render removes the rows. Expansion is the mirror image: the rows
    // already exist by the time we animate them in.

    function handleFolderToggle({ wrapper, expanded, folderId, keepsActiveChild, onToggle }) {
      // A folder holding the active clip keeps rendering that branch either
      // way, so animating it would only flicker.
      if (keepsActiveChild) {
        pendingExpandId = null;
        onToggle();
        return;
      }

      if (!expanded || prefersReducedMotion) {
        if (!expanded) pendingExpandId = folderId;
        onToggle();
        return;
      }

      const children = wrapper.querySelector(":scope > .clip-folder-children");
      if (!children) {
        onToggle();
        return;
      }

      runCollapseAnimation(children, onToggle);
    }

    function maybeAnimateExpand(children, folderId, keepsActiveChild) {
      if (keepsActiveChild) {
        pendingExpandId = null;
        return;
      }

      if (pendingExpandId !== folderId || prefersReducedMotion) return;
      pendingExpandId = null;
      runExpandAnimation(children);
    }

    function runCollapseAnimation(children, onToggle) {
      const animation = children.animate?.(
        [
          { opacity: 1, clipPath: "inset(0 0 0 0)" },
          { opacity: 0, clipPath: "inset(0 0 100% 0)" },
        ],
        { duration: 150, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "forwards" }
      );

      if (!animation) {
        onToggle();
        return;
      }

      animation.finished.then(onToggle).catch(onToggle);
    }

    function runExpandAnimation(children) {
      const animation = children.animate?.(
        [
          { opacity: 0, clipPath: "inset(0 0 100% 0)" },
          { opacity: 1, clipPath: "inset(0 0 0 0)" },
        ],
        { duration: 170, easing: "cubic-bezier(0.2, 0, 0, 1)" }
      );

      animation?.finished.catch(() => {});
    }
  };
})();
