// SillyTavern/public/extensions/third-party/qstar/index.js

// Import from the core script (确保路径正确)
import {
    eventSource,
    event_types,
    messageFormatting,
    // chat, // 不再直接使用 chat 元数据存储收藏
    clearChat,
    doNewChat,
    openCharacterChat,
    renameChat,
} from '../../../../script.js';

// Import from the extension helper script
import {
    getContext,
    renderExtensionTemplateAsync,
    extension_settings, // 仍然可能用于存储 *前端插件自身* 的设置（如果需要）
    // saveMetadataDebounced // 不再用于保存收藏
} from '../../../extensions.js';

// Import from the Popup utility script
import {
    Popup,
    POPUP_TYPE,
    callGenericPopup,
    POPUP_RESULT,
} from '../../../popup.js';

// Import for group chats
import { openGroupChat } from "../../../group-chats.js";

// Import from the general utility script
import {
    uuidv4, // 可能不再需要前端生成 UUID
    timestampToMoment,
    waitUntilCondition,
} from '../../../utils.js';

// --- Plugin Identification ---
const pluginName = 'qstar'; // 插件文件夹名称
const serverPluginId = 'favorites_manager'; // **必须**与后端插件的 info.id 匹配
const serverApiBase = `/api/plugins/${serverPluginId}`;

// --- Plugin Settings (Example, if needed for frontend specific settings) ---
// if (!extension_settings[pluginName]) {
//     extension_settings[pluginName] = {
//         showJumpButton: true, // 示例设置
//     };
// }

// --- State Variables ---
let favoritesPopup = null;
let currentPage = 1;
const itemsPerPage = 10; // 每页显示更多条目
let currentFilterType = 'chat'; // 'chat', 'context', 'all'
let currentFilterValue = null; // chatId, characterId/groupId, or null
let relatedChatsCache = []; // 缓存侧边栏聊天列表

// Define HTML for the favorite toggle icon
const messageButtonHtml = `
    <div class="mes_button favorite-toggle-icon" title="收藏/取消收藏">
        <i class="fa-regular fa-star"></i>
    </div>
`;

// --- API Helper Functions ---

/**
 * 获取收藏列表
 * @param {string} filterType 'chat', 'context', 'all'
 * @param {string | null} filterValue 根据 filterType 确定 (chatId, characterId/groupId, null)
 * @returns {Promise<Array>} 返回收藏项数组
 */
async function fetchFavorites(filterType = 'all', filterValue = null) {
    let url = `${serverApiBase}/favorites`;
    const params = new URLSearchParams();

    if (filterType === 'chat' && filterValue) {
        params.append('chatId', filterValue);
    } else if (filterType === 'context') {
        const context = getContext();
        if (context.characterId) {
            params.append('characterId', context.characterId);
        } else if (context.groupId) {
            params.append('groupId', context.groupId);
        }
        // 如果 context 无效，则不加参数，相当于 all
    }
    // filterType === 'all' 不需要加参数

    const queryString = params.toString();
    if (queryString) {
        url += `?${queryString}`;
    }

    console.log(`${pluginName}: fetchFavorites - Calling API: GET ${url}`);
    try {
        const response = await fetch(url, {
            headers: { ...getContext().getRequestHeaders() }
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        console.log(`${pluginName}: fetchFavorites - Received ${data.length} items for filter (${filterType}: ${filterValue})`);
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.error(`${pluginName}: fetchFavorites - Error fetching favorites:`, error);
        toastr.error(`加载收藏列表失败: ${error.message}`);
        return []; // 返回空数组表示失败
    }
}

/**
 * 获取与当前上下文相关的聊天列表（用于侧边栏）
 * @returns {Promise<Array<{chatId: string, chatName: string}>>}
 */
async function fetchRelatedChats() {
    const context = getContext();
    let url = `${serverApiBase}/related-chats`;
    const params = new URLSearchParams();

    if (context.characterId) {
        params.append('characterId', context.characterId);
    } else if (context.groupId) {
        params.append('groupId', context.groupId);
    } else {
        console.warn(`${pluginName}: fetchRelatedChats - No character or group context found.`);
        return []; // 没有上下文，无法获取相关聊天
    }

    url += `?${params.toString()}`;
    console.log(`${pluginName}: fetchRelatedChats - Calling API: GET ${url}`);

    try {
        const response = await fetch(url, {
            headers: { ...context.getRequestHeaders() }
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
         console.log(`${pluginName}: fetchRelatedChats - Received ${data.length} related chats.`);
        relatedChatsCache = Array.isArray(data) ? data : []; // 更新缓存
        return relatedChatsCache;
    } catch (error) {
        console.error(`${pluginName}: fetchRelatedChats - Error fetching related chats:`, error);
        toastr.error(`加载相关聊天列表失败: ${error.message}`);
        relatedChatsCache = []; // 清空缓存
        return [];
    }
}

/**
 * 添加收藏项
 * @param {object} messageInfo { messageId: string, sender: string, role: 'user'|'character' }
 */
async function addFavorite(messageInfo) {
    console.log(`${pluginName}: addFavorite (API Call) - 准备发送请求`, messageInfo);
    const context = getContext();
    const messageIndex = parseInt(messageInfo.messageId, 10);
    const message = context.chat[messageIndex];
    const previewText = message ? message.mes.substring(0, 300) + (message.mes.length > 300 ? '...' : '') : '[无法获取预览]';
    const chatName = context.chatName || (context.characterId ? context.name2 : `群聊 ${context.groupId?.substring(0, 8)}`);

    const payload = {
        originalChatId: context.chatId,
        originalMessageId: messageInfo.messageId, // mesid (string)
        sender: messageInfo.sender,
        role: messageInfo.role,
        characterId: context.characterId || null,
        groupId: context.groupId || null,
        messagePreview: previewText,
        originalChatName: chatName,
    };
    console.log(`${pluginName}: addFavorite - Payload:`, payload);

    try {
        const response = await fetch(`${serverApiBase}/favorites`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...context.getRequestHeaders(),
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
            // 特别处理 409 Conflict
            if (response.status === 409) {
                 throw new Error(errorData.error || '消息已被收藏');
            }
            throw new Error(`添加收藏失败: ${errorData.error || response.statusText}`);
        }

        const newFavorite = await response.json();
        console.log(`${pluginName}: 收藏成功 (API):`, newFavorite);
        toastr.success('消息已收藏');

        // 成功后立即刷新当前视图的图标状态
        await refreshFavoriteIconsInView(); // 确保图标状态更新
        // 如果收藏夹弹窗打开，并且当前显示的就是这个聊天的收藏，则刷新弹窗
        if (favoritesPopup?.isOpen() && currentFilterType === 'chat' && currentFilterValue === context.chatId) {
            updateFavoritesPopupContent(); // 仅更新内容区
        }


    } catch (error) {
        console.error(`${pluginName}: 调用 addFavorite API 时出错:`, error);
        toastr.error(`${error.message || '收藏失败'}`);
        // 调用失败时，需要将 UI 上的星星恢复原状
         const messageElement = $(`#chat .mes[mesid="${messageInfo.messageId}"]`);
         if (messageElement.length) {
            messageElement.find('.favorite-toggle-icon i').removeClass('fa-solid').addClass('fa-regular');
         }
    }
}

/**
 * 通过原始消息位置删除收藏
 * @param {string} messageId 消息的 mesid (string)
 * @returns {Promise<boolean>}
 */
async function removeFavoriteByMessageId(messageId) {
    console.log(`${pluginName}: removeFavoriteByMessageId (API Call) - 准备删除 messageId: ${messageId}`);
    const context = getContext();
    const currentChatId = context.chatId;

    if (!currentChatId) {
         console.error(`${pluginName}: removeFavoriteByMessageId - 无法获取当前 chatId，无法删除收藏`);
         toastr.error('无法确定当前聊天，无法取消收藏');
         return false;
    }

    try {
        const response = await fetch(`${serverApiBase}/favorites/by-message/${encodeURIComponent(currentChatId)}/${encodeURIComponent(messageId)}`, {
            method: 'DELETE',
            headers: { ...context.getRequestHeaders() },
        });

        if (!response.ok) {
             // 404 Not Found 是预期中的一种失败（尝试删除不存在的收藏）
             if (response.status === 404) {
                 console.warn(`${pluginName}: removeFavoriteByMessageId - 未找到要删除的收藏 (Chat: ${currentChatId}, Msg: ${messageId})`);
                 // 即使未找到，UI 可能已经是未收藏状态，但以防万一强制刷新
                 await refreshFavoriteIconsInView();
                 return true; // 操作逻辑上算“完成”了（目标状态达成）
             }
            const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
            throw new Error(`取消收藏失败: ${errorData.error || response.statusText}`);
        }

        const result = await response.json();
        console.log(`${pluginName}: 取消收藏成功 (API):`, result);
        toastr.success('收藏已取消');

        // 刷新图标
        await refreshFavoriteIconsInView();
        // 如果收藏夹弹窗打开，并且当前显示的就是这个聊天的收藏，则刷新弹窗
        if (favoritesPopup?.isOpen() && currentFilterType === 'chat' && currentFilterValue === context.chatId) {
            updateFavoritesPopupContent(); // 仅更新内容区
        }
        return true;

    } catch (error) {
        console.error(`${pluginName}: 调用 removeFavoriteByMessageId API 时出错:`, error);
        toastr.error(`取消收藏失败: ${error.message}`);
        // 调用失败时，需要将 UI 上的星星恢复原状
         const messageElement = $(`#chat .mes[mesid="${messageId}"]`);
         if (messageElement.length) {
            messageElement.find('.favorite-toggle-icon i').removeClass('fa-regular').addClass('fa-solid');
         }
         return false;
    }
}

/**
 * 通过收藏的唯一 ID 删除收藏（主要用于弹窗）
 * @param {string} favoriteId
 * @returns {Promise<boolean>}
 */
async function removeFavoriteById(favoriteId) {
    console.log(`${pluginName}: removeFavoriteById (API Call) - 准备删除 favoriteId: ${favoriteId}`);
     try {
        const response = await fetch(`${serverApiBase}/favorites/${encodeURIComponent(favoriteId)}`, {
            method: 'DELETE',
            headers: { ...getContext().getRequestHeaders() },
        });
        if (!response.ok) {
             if (response.status === 404) {
                 console.warn(`${pluginName}: removeFavoriteById - 未找到要删除的收藏 (ID: ${favoriteId})`);
                 return true; // 目标状态已达成
             }
             const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
             throw new Error(`删除收藏失败: ${errorData.error || response.statusText}`);
        }
        console.log(`${pluginName}: 收藏删除成功 (API, ID: ${favoriteId})`);
        return true; // 由调用者处理 UI 更新和提示
    } catch (error) {
         console.error(`${pluginName}: 调用 removeFavoriteById API 时出错:`, error);
         toastr.error(`删除失败: ${error.message}`);
         return false;
    }
}

/**
 * 更新收藏备注
 * @param {string} favoriteId
 * @param {string} note
 * @returns {Promise<boolean>}
 */
async function updateFavoriteNote(favoriteId, note) {
    console.log(`${pluginName}: updateFavoriteNote (API Call) - 更新 ID: ${favoriteId}`);
    try {
        const response = await fetch(`${serverApiBase}/favorites/${encodeURIComponent(favoriteId)}/note`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                ...getContext().getRequestHeaders(),
            },
            body: JSON.stringify({ note: note }),
        });
        if (!response.ok) {
             if (response.status === 404) {
                  throw new Error('未找到要更新的收藏项');
             }
            const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
            throw new Error(`更新备注失败: ${errorData.error || response.statusText}`);
        }
        const updatedFavorite = await response.json();
        console.log(`${pluginName}: 备注更新成功 (API):`, updatedFavorite);
        toastr.success('备注已更新');
        return true;
    } catch (error) {
         console.error(`${pluginName}: 调用 updateFavoriteNote API 时出错:`, error);
         toastr.error(`更新备注失败: ${error.message}`);
         return false;
    }
}


// --- UI Update Functions ---

/**
 * 添加收藏图标到没有图标的消息元素上
 */
function addFavoriteIconsToMessages() {
    $('#chat').find('.mes').each(function() {
        const messageElement = $(this);
        // 确保是聊天消息元素（排除系统消息等）并且有 .extraMesButtons
        if (messageElement.find('.extraMesButtons').length > 0 && !messageElement.find('.favorite-toggle-icon').length) {
            messageElement.find('.extraMesButtons').append(messageButtonHtml);
        }
    });
}

/**
 * 刷新当前聊天视图中所有消息的收藏图标状态
 */
async function refreshFavoriteIconsInView() {
    console.log(`${pluginName}: refreshFavoriteIconsInView (API Call) - 开始刷新图标`);
    addFavoriteIconsToMessages(); // 确保所有消息都有图标 DOM 结构

    const context = getContext();
    const currentChatId = context.chatId;
    if (!currentChatId) {
        $('#chat').find('.favorite-toggle-icon i').removeClass('fa-solid').addClass('fa-regular');
        console.log(`${pluginName}: refreshFavoriteIconsInView - 没有当前 chatId，所有图标设为未收藏`);
        return;
    }

    let favoritesInThisChatMap = new Map();
    try {
        const favoritesInThisChat = await fetchFavorites('chat', currentChatId);
        favoritesInThisChat.forEach(fav => favoritesInThisChatMap.set(fav.originalMessageId, fav.id));
         console.log(`${pluginName}: refreshFavoriteIconsInView - 当前聊天 (${currentChatId}) 获取到 ${favoritesInThisChatMap.size} 条收藏`);
    } catch (error) {
        console.error(`${pluginName}: refreshFavoriteIconsInView - 获取当前聊天收藏失败:`, error);
         $('#chat').find('.favorite-toggle-icon i').removeClass('fa-solid').addClass('fa-regular'); // 获取失败则全不选中
        return;
    }

    $('#chat').find('.mes').each(function() {
        const messageElement = $(this);
        const messageId = messageElement.attr('mesid'); // 获取消息的 mesid (原始索引)
        const favIconContainer = messageElement.find('.favorite-toggle-icon');

        if (messageId && favIconContainer.length) {
            const iconElement = favIconContainer.find('i');
            const favoriteId = favoritesInThisChatMap.get(messageId);

            if (favoriteId) {
                iconElement.removeClass('fa-regular').addClass('fa-solid');
                favIconContainer.data('favorite-id', favoriteId); // 存储收藏 ID，虽然当前 toggle 不直接用
            } else {
                iconElement.removeClass('fa-solid').addClass('fa-regular');
                favIconContainer.removeData('favorite-id');
            }
        }
    });
     console.log(`${pluginName}: refreshFavoriteIconsInView - 图标刷新完成`);
}

/**
 * 渲染单个收藏项的 HTML
 * @param {object} favItem 收藏项数据对象
 * @param {number} index 列表中的索引（未使用）
 * @returns {string} HTML 字符串
 */
function renderFavoriteItem(favItem) {
    if (!favItem) return '';

    const previewTextHtml = messageFormatting(favItem.messagePreview || '[无预览]', favItem.sender, false, favItem.role === 'user', null, {}, false); // 尝试格式化预览
    const addedTime = timestampToMoment(favItem.addedTimestamp).format('YYYY-MM-DD HH:mm');
    const chatDisplayName = favItem.originalChatName || favItem.originalChatId;
    // 尝试缩短过长的聊天名称
    const shortChatName = chatDisplayName.length > 30 ? chatDisplayName.substring(0, 28) + '...' : chatDisplayName;

    return `
        <div class="favorite-item" data-fav-id="${favItem.id}" data-chat-id="${favItem.originalChatId}" data-mes-id="${favItem.originalMessageId}">
            <div class="fav-header-info">
                 <div class="fav-location" title="来源聊天: ${chatDisplayName} (ID: ${favItem.originalChatId})\n消息索引: ${favItem.originalMessageId}">
                     <i class="fa-solid fa-location-dot"></i> ${shortChatName} / #${favItem.originalMessageId}
                 </div>
                 <div class="fav-meta">
                     <span class="fav-sender">${favItem.sender}</span>
                     <span class="fav-time" title="收藏时间">${addedTime}</span>
                 </div>
            </div>
            <div class="fav-note" style="${favItem.note ? '' : 'display:none;'}">${favItem.note || ''}</div>
            <div class="fav-preview">${previewTextHtml}</div>
            <div class="fav-actions">
                <i class="fa-solid fa-pencil action-edit-note" title="编辑备注"></i>
                <i class="fa-solid fa-trash action-delete-fav" title="删除收藏"></i>
                <i class="fa-solid fa-arrow-up-right-from-square action-jump-to-chat" title="跳转到原始聊天位置 (可能需要加载历史记录)"></i>
            </div>
        </div>
    `;
}

/**
 * 更新收藏夹弹窗的主内容区域（列表和分页）
 */
async function updateFavoritesPopupContent() {
    if (!favoritesPopup || !favoritesPopup.content) return;
    console.log(`${pluginName}: updateFavoritesPopupContent - Updating content for filter (${currentFilterType}: ${currentFilterValue})`);

    const listContainer = $(favoritesPopup.content).find('.favorites-list-content');
    const paginationContainer = $(favoritesPopup.content).find('.favorites-pagination');
    const statusContainer = $(favoritesPopup.content).find('.favorites-status');

    if (!listContainer.length || !paginationContainer.length || !statusContainer.length) {
        console.error(`${pluginName}: Popup content structure is missing required elements.`);
        showFavoritesPopup(); // 尝试重新渲染整个弹窗
        return;
    }

    listContainer.html('<div class="spinner"></div>'); // 显示加载状态
    paginationContainer.empty();
    statusContainer.empty();

    const favorites = await fetchFavorites(currentFilterType, currentFilterValue);
    const totalFavorites = favorites.length;

    // 更新状态信息（可选，显示当前筛选条件）
    let filterDesc = '';
    if (currentFilterType === 'chat') filterDesc = `当前聊天 (${currentFilterValue ? currentFilterValue.substring(0, 8) + '...' : '未知'})`;
    else if (currentFilterType === 'context') filterDesc = '当前角色/群组';
    else filterDesc = '所有收藏';
    statusContainer.text(`显示: ${filterDesc} - ${totalFavorites} 条`);


    listContainer.empty(); // 清空加载动画

    if (totalFavorites === 0) {
        listContainer.html(`<div class="favorites-empty">没有找到符合条件的收藏项。</div>`);
    } else {
        const totalPages = Math.max(1, Math.ceil(totalFavorites / itemsPerPage));
        if (currentPage > totalPages) currentPage = totalPages;
        if (currentPage < 1) currentPage = 1;

        const startIndex = (currentPage - 1) * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, totalFavorites);
        const currentPageItems = favorites.slice(startIndex, endIndex);

        currentPageItems.forEach((favItem) => {
            listContainer.append(renderFavoriteItem(favItem));
        });

        // 更新分页控件
        if (totalPages > 1) {
            let paginationHtml = `<button class="menu_button pagination-prev" ${currentPage === 1 ? 'disabled' : ''}>上一页</button>`;
            paginationHtml += `<span>${currentPage} / ${totalPages}</span>`;
            paginationHtml += `<button class="menu_button pagination-next" ${currentPage === totalPages ? 'disabled' : ''}>下一页</button>`;
            paginationContainer.html(paginationHtml);
        }
    }
}

/**
 * 打开或更新收藏夹弹窗
 */
async function showFavoritesPopup() {
    const context = getContext();
    if (!context) {
        toastr.error("无法获取上下文信息！");
        return;
    }

    // 设置初始过滤条件
    currentFilterType = 'chat';
    currentFilterValue = context.chatId;
    currentPage = 1; // 重置页码

    if (!favoritesPopup) {
        favoritesPopup = new Popup('', POPUP_TYPE.TEXT, '', {
            title: '收藏夹',
            wide: true, // 使用宽弹窗
            large: true, // 使用大弹窗以容纳侧边栏
            okButton: false,
            cancelButton: true, // 提供关闭按钮
            cancelButtonText: '关闭',
            allowVerticalScrolling: false, // 弹窗本身不滚动，内部区域滚动
            blurBackground: false // 减少性能消耗
        });

        // 绑定弹窗内部事件 (使用事件委托)
        $(favoritesPopup.content).on('click', async function(event) {
            const target = $(event.target);

            // --- 侧边栏点击 ---
            if (target.closest('.fav-sidebar-item').length) {
                const item = target.closest('.fav-sidebar-item');
                const filterType = item.data('filter-type');
                const filterValue = item.data('filter-value');

                // 切换选中状态
                $(favoritesPopup.content).find('.fav-sidebar-item.selected').removeClass('selected');
                item.addClass('selected');

                // 更新状态并刷新内容
                currentFilterType = filterType;
                currentFilterValue = filterValue || null; // null for 'all'/'context'
                currentPage = 1; // 重置页码
                await updateFavoritesPopupContent(); // 异步更新列表
            }
            // --- 分页点击 ---
            else if (target.hasClass('pagination-prev')) {
                if (currentPage > 1) {
                    currentPage--;
                    await updateFavoritesPopupContent();
                }
            } else if (target.hasClass('pagination-next')) {
                 // 需要重新计算总页数，因为 updateFavoritesPopupContent 会重新 fetch
                 const listContainer = $(favoritesPopup.content).find('.favorites-list-content');
                 const totalFavorites = await fetchFavorites(currentFilterType, currentFilterValue).then(f => f.length); // 低效，但简单
                 const totalPages = Math.max(1, Math.ceil(totalFavorites / itemsPerPage));
                if (currentPage < totalPages) {
                    currentPage++;
                    await updateFavoritesPopupContent();
                }
            }
            // --- 收藏项操作按钮点击 ---
            else if (target.hasClass('action-edit-note')) {
                const favItem = target.closest('.favorite-item');
                const favId = favItem.data('fav-id');
                if (favId) await handleEditNote(favId, favItem); // 传入 favItem 以获取当前备注
            } else if (target.hasClass('action-delete-fav')) {
                const favItem = target.closest('.favorite-item');
                const favId = favItem.data('fav-id');
                 if (favId) await handleDeleteFavoriteFromPopup(favId); // 删除后会刷新列表
            } else if (target.hasClass('action-jump-to-chat')) {
                const favItem = target.closest('.favorite-item');
                const chatId = favItem.data('chat-id');
                const mesId = favItem.data('mes-id');
                 if (chatId && mesId) {
                     handleJumpToChat(chatId, mesId);
                     favoritesPopup.hide(); // 跳转后关闭弹窗
                 }
            }
        });
    }

    // --- 构建弹窗基础结构 (每次打开时都重新构建，以获取最新的侧边栏) ---
    favoritesPopup.content.innerHTML = `
        <div id="favorites-popup-layout">
            <div class="fav-sidebar">
                <div class="fav-sidebar-header">浏览</div>
                <div class="fav-sidebar-content"><div class="spinner"></div></div>
            </div>
            <div class="fav-main-content">
                <div class="favorites-status"></div>
                <div class="favorites-list-content"><div class="spinner"></div></div>
                <div class="favorites-pagination"></div>
            </div>
        </div>
    `;

    favoritesPopup.show();

    // --- 异步获取侧边栏和初始列表数据 ---
    try {
        // 1. 获取相关聊天列表并填充侧边栏
        const relatedChats = await fetchRelatedChats(); // 使用缓存或重新获取
        const sidebarContent = $(favoritesPopup.content).find('.fav-sidebar-content');
        sidebarContent.empty(); // 清空加载动画

        // 添加固定选项
        sidebarContent.append(`
            <div class="fav-sidebar-item ${currentFilterType === 'chat' ? 'selected' : ''}" data-filter-type="chat" data-filter-value="${context.chatId}" title="${context.chatName || context.chatId}">
                <i class="fa-solid fa-message"></i> 当前聊天
            </div>
            <div class="fav-sidebar-item ${currentFilterType === 'context' ? 'selected' : ''}" data-filter-type="context" data-filter-value="">
                <i class="fa-solid ${context.characterId ? 'fa-user' : 'fa-users'}"></i> 当前 ${context.characterId ? '角色' : '群组'} 全部
            </div>
             <div class="fav-sidebar-item ${currentFilterType === 'all' ? 'selected' : ''}" data-filter-type="all" data-filter-value="">
                <i class="fa-solid fa-globe"></i> 所有收藏
            </div>
             <hr>
        `);

        // 添加相关聊天条目
        if (relatedChats.length > 0) {
             relatedChats.forEach(chatInfo => {
                 // 如果是当前聊天，则跳过，已经在上面添加了
                 if (chatInfo.chatId === context.chatId) return;
                 const displayName = chatInfo.chatName || chatInfo.chatId;
                 const shortName = displayName.length > 25 ? displayName.substring(0, 23) + '...' : displayName;
                 sidebarContent.append(`
                     <div class="fav-sidebar-item" data-filter-type="chat" data-filter-value="${chatInfo.chatId}" title="${displayName} (ID: ${chatInfo.chatId})">
                        <i class="fa-regular fa-comments"></i> ${shortName}
                     </div>`);
             });
        } else {
            sidebarContent.append('<div class="fav-sidebar-empty">无其他相关聊天</div>');
        }

        // 2. 获取并显示初始列表内容 (当前聊天)
        await updateFavoritesPopupContent(); // 使用初始 filterType 和 filterValue

    } catch (error) {
        console.error(`${pluginName}: Error initializing popup content:`, error);
        favoritesPopup.content.innerHTML = `<div class="error">加载收藏夹失败: ${error.message}</div>`;
    }
}


// --- Event Handlers ---

/**
 * 处理收藏图标点击事件
 * @param {Event} event
 */
function handleFavoriteToggle(event) {
    console.log(`${pluginName}: handleFavoriteToggle - 开始执行`);
    const favIconContainer = $(event.target).closest('.favorite-toggle-icon');
    if (!favIconContainer.length) return;

    const messageElement = favIconContainer.closest('.mes');
    if (!messageElement.length) return;

    const messageIdString = messageElement.attr('mesid'); // mesid (string)
    if (!messageIdString) return;

    const context = getContext();
    if (!context || !context.chat) return;

    const messageIndex = parseInt(messageIdString, 10);
    const message = context.chat[messageIndex];
    if (!message) return;

    const iconElement = favIconContainer.find('i');
    const isCurrentlyFavorited = iconElement.hasClass('fa-solid');

    // 立即更新 UI (乐观更新)
    if (isCurrentlyFavorited) {
        iconElement.removeClass('fa-solid').addClass('fa-regular');
         console.log(`${pluginName}: handleFavoriteToggle - UI 更新为取消收藏 (调用 API)`);
         // 调用 API 删除
         removeFavoriteByMessageId(messageIdString); // 不用 await，让它在后台执行
    } else {
        iconElement.removeClass('fa-regular').addClass('fa-solid');
        console.log(`${pluginName}: handleFavoriteToggle - UI 更新为收藏 (调用 API)`);
        // 准备信息并调用 API 添加
        const messageInfo = {
            messageId: messageIdString,
            sender: message.name,
            role: message.is_user ? 'user' : 'character',
        };
        addFavorite(messageInfo); // 不用 await
    }
    console.log(`${pluginName}: handleFavoriteToggle - 执行完毕`);
}

/**
 * 处理弹窗中删除收藏按钮的点击
 * @param {string} favId
 */
async function handleDeleteFavoriteFromPopup(favId) {
    console.log(`[${pluginName}] Attempting to delete favorite from popup: favId=${favId}`);
    const confirmResult = await callGenericPopup('确定要删除这条收藏吗？', POPUP_TYPE.CONFIRM);

    if (confirmResult === POPUP_RESULT.AFFIRMATIVE) {
        const removed = await removeFavoriteById(favId); // 调用 API 版本
        if (removed) {
            toastr.success('收藏已删除');
            await updateFavoritesPopupContent(); // 更新弹窗列表
            await refreshFavoriteIconsInView(); // 刷新主聊天界面图标（以防万一）
        } else {
            // removeFavoriteById 内部处理了错误提示
            console.warn(`[${pluginName}] removeFavoriteById('${favId}') API call failed or item not found.`);
        }
    } else {
        console.log(`[${pluginName}] User cancelled favorite deletion.`);
    }
}

/**
 * 处理弹窗中编辑备注按钮的点击
 * @param {string} favId
 * @param {jQuery} favItemElement 触发事件的 .favorite-item 元素
 */
async function handleEditNote(favId, favItemElement) {
    const currentNote = favItemElement.find('.fav-note').text() || '';
    const result = await callGenericPopup('为这条收藏添加/编辑备注:', POPUP_TYPE.INPUT, currentNote);

    if (result !== null && result !== POPUP_RESULT.CANCELLED) {
        const success = await updateFavoriteNote(favId, result);
        if (success) {
            // 更新弹窗中对应项的显示
            const noteElement = favItemElement.find('.fav-note');
            noteElement.text(result);
            if (result) {
                noteElement.show();
            } else {
                noteElement.hide();
            }
        }
    }
}

/**
 * 处理跳转到原始聊天位置的按钮点击
 * @param {string} chatId
 * @param {string} mesId
 */
async function handleJumpToChat(chatId, mesId) {
     console.log(`${pluginName}: handleJumpToChat - Jumping to Chat: ${chatId}, MesID: ${mesId}`);
     toastr.info(`正在尝试跳转到聊天 ${chatId}...`);
     try {
         const context = getContext();
         let navigateSuccess = false;
         // 检查目标 chatId 是否对应群组
         const group = context.groups?.find(g => g.chat_id === chatId);

         if (group) {
             console.log(`${pluginName}: Jumping to Group Chat: ${group.id} (Chat: ${chatId})`);
             await openGroupChat(group.id, chatId); // 打开群组的特定聊天文件
             navigateSuccess = true;
         } else {
             // 否则认为是角色聊天
             console.log(`${pluginName}: Jumping to Character Chat: ${chatId}`);
             await openCharacterChat(chatId); // 传入聊天文件名
             navigateSuccess = true;
         }

         if (navigateSuccess) {
             // 等待聊天加载完成
             eventSource.once(event_types.CHAT_CHANGED, async (newChatId) => {
                 if (newChatId === chatId) {
                     console.log(`${pluginName}: Chat ${chatId} loaded. Attempting to scroll.`);
                     toastr.success(`已跳转到聊天 ${chatId}。正在查找消息...`);
                     // 尝试滚动到消息位置
                     await scrollToMessage(mesId);
                 } else {
                     console.warn(`${pluginName}: Chat changed to unexpected ID ${newChatId} after jump attempt.`);
                     toastr.warning('聊天跳转后加载异常，无法定位消息。');
                 }
             });
         }

     } catch (error) {
         console.error(`${pluginName}: handleJumpToChat - Error jumping to chat:`, error);
         toastr.error(`跳转到聊天失败: ${error.message}`);
     }
}

/**
 * 滚动到指定 mesId 的消息（可能需要加载更多消息）
 * @param {string} mesIdString
 */
async function scrollToMessage(mesIdString) {
    const targetMesId = parseInt(mesIdString, 10);
    if (isNaN(targetMesId)) return;

    const findAndScroll = () => {
        const messageElement = $(`#chat .mes[mesid="${mesIdString}"]`);
        if (messageElement.length) {
            messageElement[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
            // 添加高亮效果
            messageElement.addClass('highlight-message');
            setTimeout(() => messageElement.removeClass('highlight-message'), 2000);
            console.log(`${pluginName}: Scrolled to message ${mesIdString}.`);
            toastr.success(`已定位到消息 #${mesIdString}`);
            return true;
        }
        return false;
    };

    if (findAndScroll()) {
        return; // 消息已在当前视图
    }

    console.log(`${pluginName}: Message ${mesIdString} not found in current view. Needs logic to load more history if necessary.`);
    toastr.info(`消息 #${mesIdString} 不在当前视图中。此功能暂不支持自动加载历史记录来查找。`);
    // TODO: 实现加载更多历史记录的逻辑（复杂）
    // 简单的实现是提示用户手动向上滚动加载
}

// --- Initialization ---
jQuery(async () => {
    try {
        console.log(`${pluginName}: 前端插件加载中... (v1.1 - Server Backend)`);

        // Inject CSS styles (添加侧边栏和高亮样式)
        const styleElement = document.createElement('style');
        styleElement.innerHTML = `
            /* --- 弹窗布局 --- */
            #favorites-popup-layout {
                display: flex;
                height: 75vh; /* 或根据需要调整 */
                width: 100%;
            }
            .fav-sidebar {
                width: 200px; /* 侧边栏宽度 */
                flex-shrink: 0;
                background-color: rgba(0, 0, 0, 0.1);
                border-right: 1px solid rgba(255, 255, 255, 0.1);
                display: flex;
                flex-direction: column;
                padding: 5px;
            }
             .fav-sidebar-header {
                 padding: 10px;
                 font-weight: bold;
                 border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                 margin-bottom: 5px;
                 text-align: center;
             }
             .fav-sidebar-content {
                 flex-grow: 1;
                 overflow-y: auto;
                 padding: 5px 0;
             }
             .fav-sidebar-item {
                 padding: 8px 10px;
                 cursor: pointer;
                 border-radius: 4px;
                 margin-bottom: 3px;
                 white-space: nowrap;
                 overflow: hidden;
                 text-overflow: ellipsis;
                 transition: background-color 0.2s;
             }
             .fav-sidebar-item:hover {
                 background-color: rgba(255, 255, 255, 0.08);
             }
             .fav-sidebar-item.selected {
                 background-color: var(--selected-message-bg); /* 使用 ST 变量 */
                 font-weight: bold;
             }
            .fav-sidebar-item i {
                 margin-right: 8px;
                 width: 1em; /* 固定图标宽度 */
            }
            .fav-sidebar-empty {
                padding: 10px;
                text-align: center;
                color: #888;
                font-style: italic;
            }
             .fav-main-content {
                 flex-grow: 1;
                 padding: 10px 15px;
                 display: flex;
                 flex-direction: column;
                 overflow: hidden; /* 防止内容溢出 */
             }
             .favorites-status {
                 padding-bottom: 8px;
                 border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                 margin-bottom: 10px;
                 font-size: 0.9em;
                 color: #ccc;
             }
             .favorites-list-content {
                 flex-grow: 1;
                 overflow-y: auto; /* 列表区域滚动 */
                 margin-bottom: 10px;
             }
             .favorites-pagination {
                 flex-shrink: 0;
                 text-align: center;
                 padding-top: 10px;
                 border-top: 1px solid rgba(255, 255, 255, 0.1);
             }
             .favorites-pagination span { margin: 0 10px; }

            /* --- 收藏项样式调整 --- */
            .favorite-item {
                 border-radius: 5px;
                 margin-bottom: 12px;
                 padding: 12px;
                 background-color: rgba(0, 0, 0, 0.25);
                 position: relative;
            }
            .fav-header-info {
                 display: flex;
                 justify-content: space-between;
                 align-items: flex-start; /* 顶部对齐 */
                 margin-bottom: 8px;
                 flex-wrap: wrap;
                 gap: 5px 10px;
            }
             .fav-location {
                 font-size: 0.8em;
                 color: #b0b0b0;
                 font-style: italic;
                 white-space: nowrap;
                 overflow: hidden;
                 text-overflow: ellipsis;
                 flex-shrink: 1; /* 允许收缩 */
                 min-width: 100px; /* 避免过窄 */
             }
             .fav-location i { margin-right: 4px; }
             .fav-meta {
                 font-size: 0.8em;
                 color: #aaa;
                 text-align: right;
                 flex-shrink: 0; /* 不收缩 */
                 white-space: nowrap;
             }
             .fav-meta .fav-sender { font-weight: bold; margin-right: 8px; }
            .fav-note {
                 background-color: rgba(255, 255, 0, 0.08);
                 padding: 6px 8px;
                 border-left: 3px solid #ffcc00;
                 margin: 5px 0 8px 0;
                 font-style: italic;
                 font-size: 0.9em;
                 text-align: left;
                 word-wrap: break-word;
            }
            .fav-preview {
                 margin-bottom: 10px;
                 line-height: 1.4;
                 max-height: 150px; /* 限制预览高度 */
                 overflow-y: auto;
                 word-wrap: break-word;
                 white-space: pre-wrap;
                 text-align: left;
                 font-size: 0.95em;
                 padding: 5px;
                 background: rgba(255,255,255,0.03);
                 border-radius: 3px;
            }
            .fav-actions {
                 text-align: right;
            }
            .fav-actions i {
                 cursor: pointer;
                 margin-left: 12px;
                 padding: 5px;
                 font-size: 1em;
                 color: #bbb;
                 transition: color 0.2s, background-color 0.2s;
                 border-radius: 3px;
            }
            .fav-actions i:hover { color: #fff; background-color: rgba(255, 255, 255, 0.1); }
            .fav-actions .action-edit-note { color: #6bbdff; }
            .fav-actions .action-delete-fav { color: #ff6b6b; }
            .fav-actions .action-jump-to-chat { color: #8fceff; }

            /* --- 其他 --- */
            .favorite-toggle-icon i.fa-regular { color: #999; }
            .favorite-toggle-icon i.fa-solid { color: #ffcc00; }
             .highlight-message { /* 跳转后高亮消息 */
                 animation: highlight-anim 2s ease-out;
             }
             @keyframes highlight-anim {
                 0% { background-color: rgba(255, 220, 0, 0.3); }
                 100% { background-color: transparent; }
             }
        `;
        document.head.appendChild(styleElement);

        // Add button to the top menu (data bank wand container)
        try {
            // Assuming you have an input_button.html template for this button
            const inputButtonHtml = await renderExtensionTemplateAsync(`third-party/${pluginName}`, 'input_button');
            $('#data_bank_wand_container').append(inputButtonHtml);
            $('#favorites_button').on('click', showFavoritesPopup);
             console.log(`${pluginName}: 收藏夹按钮已添加`);
        } catch (error) {
             console.error(`${pluginName}: 加载或注入收藏夹按钮失败:`, error);
             // Fallback: Add a simple button if template fails
             if ($('#favorites_button').length === 0) {
                 const fallbackButton = $('<button id="favorites_button" class="fa-solid fa-star menu_button" title="收藏夹"></button>');
                 fallbackButton.on('click', showFavoritesPopup);
                 $('#data_bank_wand_container').append(fallbackButton);
                 console.log(`${pluginName}: 已添加备用收藏夹按钮`);
             }
        }

        // Add settings section (if you have settings_display.html)
        try {
            const settingsHtml = await renderExtensionTemplateAsync(`third-party/${pluginName}`, 'settings_display');
            $('#extensions_settings').append(settingsHtml);
             console.log(`${pluginName}: 设置 UI 已添加 (如有)`);
        } catch (error) {
             console.log(`${pluginName}: 未找到或加载设置 UI 模板，跳过。`);
        }

        // --- Event Delegation for Favorite Toggle Icon ---
        // Use document to catch clicks even if #chat is re-rendered
        $(document).on('click', '.favorite-toggle-icon', handleFavoriteToggle);

        // --- Initial UI Setup ---
        addFavoriteIconsToMessages();
        await refreshFavoriteIconsInView(); // Initial icon state based on current chat

        // --- SillyTavern Event Listeners ---
        eventSource.on(event_types.CHAT_CHANGED, async (newChatId) => {
            console.log(`${pluginName}: CHAT_CHANGED event detected. New Chat ID: ${newChatId}`);
            // 聊天切换时，必须刷新当前视图的图标
            await refreshFavoriteIconsInView();
            // 如果收藏夹弹窗是打开的，关闭它，因为上下文变了
            if (favoritesPopup && favoritesPopup.isOpen()) {
                 console.log(`${pluginName}: Chat changed, closing favorites popup.`);
                 favoritesPopup.hide();
            }
        });

        eventSource.on(event_types.MESSAGE_DELETED, async (deletedMessageIndex) => {
             const deletedMessageId = String(deletedMessageIndex);
             const context = getContext(); // 需要获取当前 chatId
             console.log(`${pluginName}: MESSAGE_DELETED event detected. Index: ${deletedMessageIndex}, ChatID: ${context.chatId}`);
             if (!context.chatId) return;

             // 尝试通过 API 删除对应的收藏
             try {
                 const response = await fetch(`${serverApiBase}/favorites/by-message/${encodeURIComponent(context.chatId)}/${encodeURIComponent(deletedMessageId)}`, {
                     method: 'DELETE',
                     headers: { ...context.getRequestHeaders() }
                 });
                 if (response.ok) {
                     console.log(`${pluginName}: Successfully removed favorite via API due to message deletion (if it existed).`);
                     // 如果弹窗打开，并且显示的是当前聊天，刷新它
                     if (favoritesPopup?.isOpen() && currentFilterType === 'chat' && currentFilterValue === context.chatId) {
                        await updateFavoritesPopupContent();
                     }
                 } else if (response.status !== 404) { // 忽略 404 (收藏本就不存在)
                     console.error(`${pluginName}: Failed to remove favorite via API after message deletion. Status: ${response.status}`);
                 }
             } catch (error) {
                 console.error(`${pluginName}: Error calling delete favorite API after message deletion:`, error);
             }
             // 不需要手动刷新图标，因为被删除的消息元素已经没了
        });

        // Ensure icons are added when new messages appear
        const handleNewOrUpdatedMessages = () => {
             setTimeout(() => {
                 addFavoriteIconsToMessages();
                 // refreshFavoriteIconsInView(); // 一般不需要，新消息默认未收藏，切换聊天时会刷新
             }, 150);
        };
        eventSource.on(event_types.MESSAGE_RECEIVED, handleNewOrUpdatedMessages);
        eventSource.on(event_types.MESSAGE_SENT, handleNewOrUpdatedMessages);
        eventSource.on(event_types.MESSAGE_SWIPED, refreshFavoriteIconsInView); // 滑动可能改变消息内容，刷新图标状态
        eventSource.on(event_types.MESSAGE_UPDATED, refreshFavoriteIconsInView); // 编辑消息后刷新
        eventSource.on(event_types.MORE_MESSAGES_LOADED, async () => { // 加载更多后需要添加并刷新
             console.log(`${pluginName}: MORE_MESSAGES_LOADED event detected.`);
             setTimeout(async () => {
                 addFavoriteIconsToMessages();
                 await refreshFavoriteIconsInView();
             }, 150);
        });

        // MutationObserver to catch dynamic additions (less critical now with event listeners, but good fallback)
        const chatObserver = new MutationObserver((mutations) => {
            let needsIconAddition = false;
            for (const mutation of mutations) {
                if (mutation.type === 'childList' && mutation.addedNodes.length) {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType === 1 && (node.classList.contains('mes') || node.querySelector('.mes'))) {
                            needsIconAddition = true;
                        }
                    });
                }
            }
            if (needsIconAddition) {
                 // console.log(`${pluginName}: MutationObserver detected potential new messages.`);
                 setTimeout(addFavoriteIconsToMessages, 200);
            }
        });
        const chatElement = document.getElementById('chat');
        if (chatElement) {
            chatObserver.observe(chatElement, { childList: true, subtree: true });
        } else {
             console.error(`${pluginName}: Could not find #chat element for MutationObserver.`);
        }

        console.log(`${pluginName}: 前端插件加载完成! (Server Backend Mode)`);

    } catch (error) {
        console.error(`${pluginName}: 初始化过程中出错:`, error);
        toastr.error(`收藏夹插件初始化失败: ${error.message}`);
    }
});
