import { h, render } from 'vue';
import Drawflow from 'drawflow';
import '@/assets/css/drawflow.css';

const blockComponents = require.context('../components/block', false, /\.vue$/);

export default function (element, { context, options = {} }) {
  const editor = new Drawflow(element, { render, version: 3, h }, context);

  editor.useuuid = true;
  editor.translate_to = function (x, y, zoom) {
    if (typeof x !== 'number' || typeof y !== 'number') return;

    this.canvas_x = x;
    this.canvas_y = y;

    this.zoom = 1;

    this.precanvas.style.transform = `translate(${this.canvas_x}px, ${this.canvas_y}px) scale(${this.zoom})`;
    this.zoom = zoom;
    this.zoom_last_value = 1;
    this.zoom_refresh();
  };
  editor.createCurvature = (
    startPosX,
    startPosY,
    endPosX,
    endPosY,
    curvatureValue,
    type
  ) => {
    const curvature = options.disableCurvature ? 0 : curvatureValue;
    const generateCurvature = (start = false) => {
      if (start) {
        return startPosX + Math.abs(endPosX - startPosX) * curvature;
      }

      return endPosX - Math.abs(endPosX - startPosX) * curvature;
    };

    switch (type) {
      case 'open': {
        const hx1 = generateCurvature(true);
        let hx2 = generateCurvature();

        if (startPosX >= endPosX) {
          hx2 = endPosX - Math.abs(endPosX - startPosX) * (curvature * -1);
        }

        return ` M ${startPosX} ${startPosY} C ${hx1} ${startPosY} ${hx2} ${endPosY} ${endPosX}  ${endPosY}`;
      }
      case 'close': {
        let hx1 = generateCurvature(true);
        const hx2 = generateCurvature();

        if (startPosX >= endPosX) {
          hx1 = startPosX + Math.abs(endPosX - startPosX) * (curvature * -1);
        }

        const posX = options.arrow ? endPosX - 10 : endPosX;

        return ` M ${startPosX} ${startPosY} C ${hx1} ${startPosY} ${hx2} ${endPosY} ${posX} ${endPosY}`;
      }
      case 'other': {
        let hx1 = generateCurvature(true);
        let hx2 = generateCurvature();

        if (startPosX >= endPosX) {
          hx1 = startPosX + Math.abs(endPosX - startPosX) * (curvature * -1);
          hx2 = endPosX - Math.abs(endPosX - startPosX) * (curvature * -1);
        }

        return ` M ${startPosX} ${startPosY} C ${hx1} ${startPosY} ${hx2} ${endPosY} ${endPosX} ${endPosY}`;
      }
      default: {
        let line = '';
        const posX = options.arrow ? endPosX - 10 : endPosX;

        if (!options.disableCurvature) {
          const hx1 = generateCurvature(true);
          const hx2 = generateCurvature();

          line = `M${startPosX} ${startPosY} C${hx1} ${startPosY} ${hx2} ${endPosY} ${posX} ${endPosY}`;
        } else {
          const centerX =
            Math.abs(endPosX - startPosX) < 300
              ? (endPosX - startPosX) / 2 + startPosX
              : startPosX + 150;
          let firstLine = `L${centerX} ${startPosY} L${centerX} ${endPosY}`;

          if (startPosX >= endPosX) {
            const centerY = (endPosY - startPosY) / 2 + startPosY;

            firstLine = ` L${startPosX} ${startPosY} L${startPosX} ${centerY} L${posX} ${centerY}`;
          }

          line = `M ${startPosX} ${startPosY} ${firstLine} L${posX} ${endPosY}`;
        }

        return line;
      }
    }
  };

  Object.entries(options).forEach(([key, value]) => {
    editor[key] = value;
  });

  blockComponents.keys().forEach((key) => {
    const name = key.replace(/(.\/)|\.vue$/g, '');

    editor.registerNode(name, blockComponents(key).default, { editor }, {});
  });

  return editor;
}
