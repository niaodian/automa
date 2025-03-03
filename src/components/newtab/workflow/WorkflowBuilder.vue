<template>
  <div
    v-bind="{ arrow: $store.state.settings.editor.arrow }"
    id="drawflow"
    class="parent-drawflow relative"
    @drop="dropHandler"
    @dragover.prevent="handleDragOver"
  >
    <div
      class="flex items-end absolute w-full p-4 left-0 bottom-0 justify-between z-10"
    >
      <div id="zoom">
        <button
          v-tooltip.group="t('workflow.editor.resetZoom')"
          class="p-2 rounded-lg bg-white dark:bg-gray-800 mr-2"
          @click="editor.zoom_reset()"
        >
          <v-remixicon name="riFullscreenLine" />
        </button>
        <div class="rounded-lg bg-white dark:bg-gray-800 inline-block">
          <button
            v-tooltip.group="t('workflow.editor.zoomOut')"
            class="p-2 rounded-lg relative z-10"
            @click="editor.zoom_out()"
          >
            <v-remixicon name="riSubtractLine" />
          </button>
          <hr class="h-6 border-r inline-block" />
          <button
            v-tooltip.group="t('workflow.editor.zoomIn')"
            class="p-2 rounded-lg"
            @click="editor.zoom_in()"
          >
            <v-remixicon name="riAddLine" />
          </button>
        </div>
        <workflow-builder-search-blocks :editor="editor" />
      </div>
      <slot v-bind="{ editor }"></slot>
    </div>
    <ui-popover
      v-model="contextMenu.show"
      :options="contextMenu.position"
      padding="p-3"
    >
      <ui-list class="space-y-1 w-52">
        <ui-list-item
          v-for="item in contextMenu.items"
          :key="item.id"
          v-close-popover
          class="cursor-pointer justify-between"
          @click="contextMenuHandler[item.event]"
        >
          <span>
            {{ item.name }}
          </span>
          <span
            v-if="item.shortcut"
            class="text-sm capitalize text-gray-600 dark:text-gray-200"
          >
            {{ item.shortcut }}
          </span>
        </ui-list-item>
      </ui-list>
    </ui-popover>
  </div>
</template>
<script>
/* eslint-disable camelcase */
import {
  onMounted,
  shallowRef,
  reactive,
  getCurrentInstance,
  watch,
  onBeforeUnmount,
} from 'vue';
import { useStore } from 'vuex';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { compare } from 'compare-versions';
import defu from 'defu';
import SelectionArea from '@viselect/vanilla';
import browser from 'webextension-polyfill';
import emitter from '@/lib/mitt';
import {
  useShortcut,
  getShortcut,
  getReadableShortcut,
} from '@/composable/shortcut';
import { tasks, excludeOnError } from '@/utils/shared';
import { parseJSON } from '@/utils/helper';
import { useGroupTooltip } from '@/composable/groupTooltip';
import drawflow from '@/lib/drawflow';
import WorkflowBuilderSearchBlocks from './WorkflowBuilderSearchBlocks.vue';

export default {
  components: { WorkflowBuilderSearchBlocks },
  props: {
    data: {
      type: [Object, String],
      default: null,
    },
    isShared: {
      type: Boolean,
      default: false,
    },
    version: {
      type: [String, Boolean],
      default: '',
    },
    mode: {
      type: String,
      default: 'edit',
    },
  },
  emits: ['load', 'deleteBlock', 'update', 'save'],
  setup(props, { emit }) {
    useGroupTooltip();

    const { t } = useI18n();
    const route = useRoute();
    const store = useStore();

    const contextMenuItems = {
      common: [
        {
          id: 'paste',
          name: t('workflow.editor.paste'),
          icon: 'riFileCopyLine',
          event: 'pasteBlocks',
          shortcut: getReadableShortcut('mod+v'),
        },
      ],
      block: [
        {
          id: 'copy',
          name: t('workflow.editor.copy'),
          icon: 'riFileCopyLine',
          event: 'copyBlocks',
          shortcut: getReadableShortcut('mod+c'),
        },
        {
          id: 'duplicate',
          name: t('workflow.editor.duplicate'),
          icon: 'riFileCopyLine',
          event: 'duplicateBlock',
          shortcut: getShortcut('editor:duplicate-block').readable,
        },
        {
          id: 'delete',
          name: t('common.delete'),
          icon: 'riDeleteBin7Line',
          event: 'deleteBlock',
          shortcut: 'Del',
        },
      ],
    };

    let activeNode = null;
    let hasDragged = false;
    let isDragging = false;
    let selectedElements = [];

    const selection = shallowRef(null);
    const editor = shallowRef(null);
    const contextMenu = reactive({
      items: [],
      data: null,
      show: false,
      position: {},
    });

    const workflowId = route.params.id;

    const prevSelectedEl = {
      output: null,
      connection: null,
      nodeContent: null,
    };
    const isOutputEl = (el) => el.classList.contains('output');
    const isConnectionEl = (el) =>
      el.matches('path.main-path') ||
      el.parentElement.classList.contains('connection');

    function toggleHoverClass({ target, name, active, classes }) {
      const prev = prevSelectedEl[name];

      if (active) {
        if (prev === target) return;

        target.classList.toggle(classes, true);
      } else if (prev) {
        prev.classList.toggle(classes, false);
      }

      prevSelectedEl[name] = target;
    }
    function handleDragOver({ target }) {
      toggleHoverClass({
        target,
        name: 'connection',
        classes: 'selected',
        active: isConnectionEl(target),
      });
      toggleHoverClass({
        target,
        name: 'output',
        classes: 'ring-4',
        active: isOutputEl(target),
      });

      const nodeContent = target.closest(
        '.drawflow-node:not(.blocks-group) .drawflow_content_node'
      );
      toggleHoverClass({
        classes: 'ring-4',
        target: nodeContent,
        name: 'nodeContent',
        active: nodeContent,
      });
    }
    function dropHandler({ dataTransfer, clientX, clientY, target }) {
      const block = JSON.parse(dataTransfer.getData('block') || null);

      if (!block) return;

      const highlightedEls = document.querySelectorAll(
        '.drawflow_content_node.ring-4'
      );
      highlightedEls.forEach((el) => {
        el.classList.remove('ring-4');
      });

      const isTriggerExists =
        block.id === 'trigger' &&
        editor.value.getNodesFromName('trigger').length !== 0;
      if (isTriggerExists) return;

      if (target.closest('.drawflow_content_node')) {
        const targetNodeId = target
          .closest('.drawflow-node')
          .id.replace(/node-/, '');
        const targetNode = editor.value.getNodeFromId(targetNodeId);
        editor.value.removeNodeId(`node-${targetNodeId}`);

        if (targetNode.name === 'blocks-group') return;

        let targetBlock = block;
        if (block.fromBlockBasic) {
          targetBlock = { ...tasks[block.id], id: block.id };
        }

        const onErrorEnabled =
          targetNode.data?.onError?.enable &&
          !excludeOnError.includes(targetBlock.id);
        const newNodeData = onErrorEnabled
          ? { ...targetBlock.data, onError: targetNode.data.onError }
          : targetBlock.data;

        const newNodeId = editor.value.addNode(
          targetBlock.id,
          targetBlock.inputs,
          targetBlock.outputs,
          targetNode.pos_x,
          targetNode.pos_y,
          targetBlock.id,
          newNodeData,
          targetBlock.component,
          'vue'
        );

        if (onErrorEnabled && targetNode.data.onError.toDo === 'fallback') {
          editor.value.addNodeOutput(newNodeId);
        }

        const duplicateConnections = (nodeIO, type) => {
          if (block[type] === 0) return;

          Object.keys(nodeIO).forEach((name) => {
            const { connections } = nodeIO[name];

            connections.forEach(({ node, input, output }) => {
              if (node === targetNodeId) return;

              if (type === 'inputs') {
                editor.value.addConnection(node, newNodeId, input, name);
              } else if (type === 'outputs') {
                editor.value.addConnection(newNodeId, node, name, output);
              }
            });
          });
        };

        duplicateConnections(targetNode.inputs, 'inputs');
        duplicateConnections(targetNode.outputs, 'outputs');

        emitter.emit('editor:data-changed');

        return;
      }

      if (block.fromBlockBasic) return;

      const xPosition =
        clientX *
          (editor.value.precanvas.clientWidth /
            (editor.value.precanvas.clientWidth * editor.value.zoom)) -
        editor.value.precanvas.getBoundingClientRect().x *
          (editor.value.precanvas.clientWidth /
            (editor.value.precanvas.clientWidth * editor.value.zoom));
      const yPosition =
        clientY *
          (editor.value.precanvas.clientHeight /
            (editor.value.precanvas.clientHeight * editor.value.zoom)) -
        editor.value.precanvas.getBoundingClientRect().y *
          (editor.value.precanvas.clientHeight /
            (editor.value.precanvas.clientHeight * editor.value.zoom));

      const blockId = editor.value.addNode(
        block.id,
        block.inputs,
        block.outputs,
        xPosition + 25,
        yPosition - 25,
        block.id,
        block.data,
        block.component,
        'vue'
      );

      if (block.fromGroup) {
        const blockEl = document.getElementById(`node-${blockId}`);

        blockEl.setAttribute('group-item-id', block.itemId);
      }

      if (isConnectionEl(target)) {
        target.classList.remove('selected');

        const classes = target.parentElement.classList.toString();
        const result = {};
        const items = [
          { str: 'node_in_', key: 'inputId' },
          { str: 'input_', key: 'inputClass' },
          { str: 'node_out_', key: 'outputId' },
          { str: 'output_', key: 'outputClass' },
        ];

        items.forEach(({ key, str }) => {
          result[key] = classes
            .match(new RegExp(`${str}[^\\s]*`))[0]
            ?.replace(/node_in_node-|node_out_node-/, '');
        });

        try {
          editor.value.removeSingleConnection(
            result.outputId,
            result.inputId,
            result.outputClass,
            result.inputClass
          );
          editor.value.addConnection(
            result.outputId,
            blockId,
            result.outputClass,
            'input_1'
          );
          editor.value.addConnection(
            blockId,
            result.inputId,
            'output_1',
            result.inputClass
          );
        } catch (error) {
          console.error(error);
        }
      } else if (isOutputEl(target)) {
        prevSelectedEl.output?.classList.remove('ring-4');

        const targetNodeId = target
          .closest('.drawflow-node')
          .id.replace(/node-/, '');
        const outputClass = target.classList[1];

        editor.value.addConnection(
          targetNodeId,
          blockId,
          outputClass,
          'input_1'
        );
      }

      emitter.emit('editor:data-changed');
    }
    function isInputAllowed(allowedInputs, input) {
      if (typeof allowedInputs === 'boolean') return allowedInputs;

      return allowedInputs.some((item) => {
        if (item.startsWith('#')) {
          return tasks[input].category === item.substr(1);
        }

        return item === input;
      });
    }
    function deleteBlock() {
      editor.value.removeNodeId(contextMenu.data);
    }
    function clearSelectedElements() {
      selection.value.clearSelection();
      selectedElements.forEach(({ el }) => {
        if (!el) return;

        el.classList.remove('selected-list');
      });
      selectedElements = [];
      activeNode = null;
    }
    function duplicateBlock(nodeId, isPaste = false) {
      const nodes = new Map();
      const addNode = (id) => {
        const node = editor.value.getNodeFromId(id);

        if (node.name === 'trigger') return;

        nodes.set(node.id, node);
      };

      if (isPaste) {
        store.state.copiedNodes.forEach((node) => {
          nodes.set(node.id, node);
        });
      } else {
        if (nodeId) addNode(nodeId);
        else if (activeNode) addNode(activeNode.id);

        selectedElements.forEach((node) => {
          if (activeNode?.id === node.id || nodeId === node.id) return;

          addNode(node.id);
        });
      }

      const nodesOutputs = [];

      clearSelectedElements();

      nodes.forEach((node) => {
        const { outputs, inputs } = tasks[node.name];

        const inputsLen = Object.keys(node.inputs).length;
        const outputsLen = Object.keys(node.outputs).length;

        const blockInputs = inputsLen || inputs;
        const blockOutputs = outputsLen || outputs;

        const newNodeId = editor.value.addNode(
          node.name,
          blockInputs,
          blockOutputs,
          node.pos_x + 25,
          node.pos_y + 70,
          node.name,
          node.data,
          node.html,
          'vue'
        );

        nodes.set(node.id, { ...nodes.get(node.id), newId: newNodeId });

        const nodeElement = document.querySelector(`#node-${newNodeId}`);
        nodeElement.classList.add('selected-list');
        selectedElements.push({
          id: newNodeId,
          el: nodeElement,
          posY: parseInt(nodeElement.style.top, 10),
          posX: parseInt(nodeElement.style.left, 10),
        });

        emitter.emit('editor:data-changed');

        if (outputsLen > 0) {
          nodesOutputs.push({ id: newNodeId, outputs: node.outputs });
        }
      });

      if (nodesOutputs.length < 1) return;

      nodesOutputs.forEach(({ id, outputs }) => {
        Object.keys(outputs).forEach((key) => {
          outputs[key].connections.forEach((connection) => {
            const node = nodes.get(connection.node);

            if (!node) return;

            editor.value.addConnection(id, node.newId, key, 'input_1');
          });
        });
      });
    }
    function checkWorkflowData() {
      if (!editor.value) return;

      editor.value.editor_mode = props.isShared ? 'fixed' : 'edit';
      editor.value.container.classList.toggle('is-shared', props.isShared);
    }
    function saveEditorState() {
      const editorStates =
        parseJSON(localStorage.getItem('editor-states'), {}) || {};
      editorStates[workflowId] = {
        zoom: editor.value.zoom,
        canvas_x: editor.value.canvas_x,
        canvas_y: editor.value.canvas_y,
      };

      localStorage.setItem('editor-states', JSON.stringify(editorStates));
    }
    function initSelectArea() {
      selection.value = new SelectionArea({
        container: '#drawflow',
        startareas: ['#drawflow'],
        boundaries: ['#drawflow'],
        selectables: ['.drawflow-node'],
        features: {
          singleTap: {
            allow: false,
          },
        },
      });

      selection.value.on('beforestart', ({ event }) => {
        if (!event.ctrlKey && !event.metaKey) return false;

        editor.value.editor_mode = 'fixed';
        editor.value.editor_selected = false;

        return true;
      });
      selection.value.on('move', () => {
        hasDragged = true;
      });
      selection.value.on('stop', (event) => {
        event.store.selected.forEach((el) => {
          const isExists = selectedElements.some((item) =>
            item.el.isEqualNode(el)
          );

          if (isExists) return;

          el.classList.toggle('selected-list', true);

          selectedElements.push({
            el,
            id: el.id.slice(5),
            posY: parseInt(el.style.top, 10),
            posX: parseInt(el.style.left, 10),
          });
        });

        setTimeout(() => {
          hasDragged = false;
        }, 500);
      });
    }
    function onMouseup({ target }) {
      editor.value.editor_mode = 'edit';

      const isNodeEl = target.closest('.drawflow-node');
      if (!isNodeEl) return;

      const getPosition = (el) => {
        return {
          posY: parseInt(el.style.top, 10),
          posX: parseInt(el.style.left, 10),
        };
      };

      selectedElements.forEach(({ el }, index) => {
        Object.assign(selectedElements[index], getPosition(el));
      });

      if (activeNode) Object.assign(activeNode, getPosition(activeNode.el));

      isDragging = false;
    }
    function onMousedown({ target }) {
      const nodeEl = target.closest('.drawflow-node');
      if (!nodeEl) return;

      if (nodeEl.classList.contains('selected-list')) {
        activeNode = {
          el: nodeEl,
          id: nodeEl.id.slice(5),
          posY: parseInt(nodeEl.style.top, 10),
          posX: parseInt(nodeEl.style.left, 10),
        };
      }

      isDragging = true;
    }
    function onClick({ ctrlKey, metaKey, target }) {
      const nodeEl = target.closest('.drawflow-node');
      if (!nodeEl) {
        if (!hasDragged) clearSelectedElements();
        return;
      }

      const nodeProperties = {
        el: nodeEl,
        id: nodeEl.id.slice(5),
        posY: parseInt(nodeEl.style.top, 10),
        posX: parseInt(nodeEl.style.left, 10),
      };

      if (!ctrlKey && !metaKey && !hasDragged) {
        clearSelectedElements();

        activeNode = nodeProperties;
        nodeEl.classList.add('selected-list');
        selectedElements = [nodeProperties];
        hasDragged = false;

        return;
      }
      hasDragged = false;

      if (!ctrlKey && !metaKey) return;

      const nodeIndex = selectedElements.findIndex(({ el }) =>
        nodeEl.isEqualNode(el)
      );
      if (nodeIndex !== -1) {
        setTimeout(() => {
          nodeEl.classList.remove('selected-list', 'selected');
        }, 400);
        selectedElements.splice(nodeIndex, 1);
      } else {
        nodeEl.classList.add('selected-list');
        selectedElements.push(nodeProperties);
      }
    }
    function copyBlocks() {
      let nodes = selectedElements;

      if (nodes.length === 0) {
        const selectedEl = document.querySelector('.drawflow-node.selected');

        if (selectedEl) {
          nodes.push({ id: selectedEl.id.substr(5) });
        }
      }

      nodes = nodes.map((node) => editor.value.getNodeFromId(node.id));

      store.commit('updateState', {
        key: 'copiedNodes',
        value: nodes,
      });
    }
    function onKeyup({ key, target, ctrlKey, metaKey }) {
      if (ctrlKey || metaKey) {
        if (key === 'c') {
          copyBlocks();
        } else if (key === 'v') {
          duplicateBlock(null, true);
        }
      }

      const isAnInput =
        ['INPUT', 'TEXTAREA'].includes(target.tagName) ||
        target.isContentEditable;

      if (key !== 'Delete' || isAnInput) return;

      selectedElements.forEach(({ id }) => {
        const nodeId = `node-${id}`;
        const isNodeExists = document.querySelector(`#${nodeId}`);

        if (!isNodeExists) return;

        editor.value.removeNodeId(nodeId);
      });

      selectedElements = [];
      activeNode = null;
    }

    useShortcut('editor:duplicate-block', () => {
      if (!activeNode && selectedElements.length <= 0) return;

      duplicateBlock();
    });

    watch(() => props.isShared, checkWorkflowData);

    onMounted(() => {
      const context = getCurrentInstance().appContext.app._context;
      const element = document.querySelector('#drawflow');

      element.addEventListener('mousedown', onMousedown);
      element.addEventListener('mouseup', onMouseup);
      element.addEventListener('click', onClick);
      element.addEventListener('keyup', onKeyup);

      editor.value = drawflow(element, {
        context,
        options: {
          reroute: true,
          ...store.state.settings.editor,
        },
      });
      editor.value.start();

      emit('load', editor.value);

      if (props.data) {
        let data =
          typeof props.data === 'string'
            ? parseJSON(props.data, null)
            : props.data;

        if (!data || !data?.drawflow?.Home) return;

        const currentExtVersion = browser.runtime.getManifest().version;
        const isOldWorkflow = compare(
          currentExtVersion,
          props.version || '0.0.0',
          '>'
        );

        if (isOldWorkflow && typeof props.version !== 'boolean') {
          const newDrawflowData = Object.entries(
            data.drawflow.Home.data
          ).reduce((obj, [key, value]) => {
            obj[key] = {
              ...value,
              html: tasks[value.name].component,
              data: defu({}, value.data, tasks[value.name].data),
            };

            return obj;
          }, {});

          data = {
            drawflow: { Home: { data: newDrawflowData } },
          };

          emit('update', { version: currentExtVersion });
        }

        editor.value.import(data);

        if (isOldWorkflow) {
          setTimeout(() => {
            emit('save');
          }, 200);
        }
      } else if (!props.isShared) {
        editor.value.addNode(
          'trigger',
          0,
          1,
          50,
          300,
          'trigger',
          tasks.trigger.data,
          'BlockBasic',
          'vue'
        );
      }

      editor.value.on('mouseMove', () => {
        if (!activeNode || !isDragging) return;

        const xDistance =
          parseInt(activeNode.el.style.left, 10) - activeNode.posX;
        const yDistance =
          parseInt(activeNode.el.style.top, 10) - activeNode.posY;

        selectedElements.forEach(({ el, posX, posY }) => {
          if (el.isEqualNode(activeNode.el)) return;

          const nodeId = el.id.slice(5);
          const node = editor.value.drawflow.drawflow.Home.data[nodeId];

          const newPosX = posX + xDistance;
          const newPosY = posY + yDistance;

          node.pos_x = newPosX;
          node.pos_y = newPosY;
          el.style.top = `${newPosY}px`;
          el.style.left = `${newPosX}px`;

          editor.value.updateConnectionNodes(el.id);
        });

        hasDragged = true;
      });
      editor.value.on('nodeRemoved', (id) => {
        emit('deleteBlock', id);
      });
      editor.value.on(
        'connectionCreated',
        ({ output_id, input_id, output_class, input_class }) => {
          const { name: inputName } = editor.value.getNodeFromId(input_id);
          const { allowedInputs } = tasks[inputName];
          const isAllowed = isInputAllowed(allowedInputs, inputName);

          if (!isAllowed) {
            editor.value.removeSingleConnection(
              output_id,
              input_id,
              output_class,
              input_class
            );
          }

          emitter.emit('editor:data-changed');
        }
      );
      editor.value.on('connectionRemoved', () => {
        emitter.emit('editor:data-changed');
      });
      editor.value.on('export', saveEditorState);
      editor.value.on('contextmenu', ({ clientY, clientX, target }) => {
        if (target.tagName === 'path' && target.classList.contains('main-path'))
          return;

        const isBlock = target.closest('.drawflow .drawflow-node');
        const virtualEl = {
          getReferenceClientRect: () => ({
            width: 0,
            height: 0,
            top: clientY,
            right: clientX,
            bottom: clientY,
            left: clientX,
          }),
        };

        if (isBlock) {
          contextMenu.data = isBlock.id;
          contextMenu.position = virtualEl;
          contextMenu.items = contextMenuItems.block;
          contextMenu.show = true;
        }

        const copiedNodesLen = store.state.copiedNodes.length;
        if (copiedNodesLen > 0) {
          if (isBlock) {
            contextMenuItems.common.forEach((item) => {
              const isExists = contextMenu.items.some(
                (menu) => menu.id === item.id
              );
              if (isExists) return;

              contextMenu.items.unshift(item);
            });
          } else {
            contextMenu.items = contextMenuItems.common;
          }

          contextMenu.position = virtualEl;
          contextMenu.show = true;
        }
      });

      const editorStates =
        parseJSON(localStorage.getItem('editor-states'), {}) || {};
      const editorState = editorStates[workflowId];
      if (editorState) {
        const { canvas_x, canvas_y, zoom } = editorState;
        editor.value.translate_to(canvas_x, canvas_y, zoom);
      }

      checkWorkflowData();
      initSelectArea();
    });
    onBeforeUnmount(() => {
      const element = document.querySelector('#drawflow');

      if (element) {
        element.removeEventListener('mousedown', onMousedown);
        element.removeEventListener('mouseup', onMouseup);
        element.removeEventListener('click', onClick);
        element.removeEventListener('keyup', onKeyup);
      }

      saveEditorState();
    });

    return {
      t,
      editor,
      contextMenu,
      dropHandler,
      handleDragOver,
      contextMenuHandler: {
        copyBlocks,
        deleteBlock,
        pasteBlocks: () => duplicateBlock(null, true),
        duplicateBlock: () => duplicateBlock(contextMenu.data.substr(5)),
      },
    };
  },
};
</script>
<style>
#drawflow {
  background-image: url('@/assets/images/tile.png');
  background-size: 35px;
  user-select: none;
}
.dark #drawflow {
  background-image: url('@/assets/images/tile-white.png');
}
.drawflow .drawflow-node {
  @apply dark:bg-gray-800;
}
#drawflow[arrow='true'] .drawflow-node .input {
  background-color: transparent !important;
  border-top: 10px solid transparent;
  border-radius: 0;
  border-left: 10px solid theme('colors.accent');
  border-right: 10px solid transparent;
  border-bottom: 10px solid transparent;
}
.selection-area {
  background: rgba(46, 115, 252, 0.11);
  border: 2px solid rgba(98, 155, 255, 0.81);
  border-radius: 0.1em;
}
.drawflow_content_node {
  @apply rounded-lg;
}
</style>
