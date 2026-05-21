/**
 * Component tests del Calibrator.
 * jsdom + jest-canvas-mock: canvas existe pero no renderiza; verificamos
 * estado/UI, no pixels. Cubrimos rutas que rompían antes de los fixes:
 *  - error visible cuando el archivo no es imagen (img.onerror y type-check)
 *  - URL.revokeObjectURL invocada cuando se carga una nueva imagen
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import Calibrator from "@/components/Calibrator";

// Capturar todas las URLs creadas y liberadas para verificar que no haya leak
let createdUrls = [];
let revokedUrls = [];
let origImage;

// jsdom no carga imágenes ni dispara onload por sí solo. Devolvemos un
// HTMLImageElement real (necesario para que jest-canvas-mock acepte
// drawImage) y patcheamos el setter de src para disparar onload async.
function installImageMock({ w = 1280, h = 720, fail = false } = {}) {
  origImage = global.Image;
  global.Image = function () {
    const img = document.createElement("img");
    Object.defineProperty(img, "naturalWidth", { value: w, writable: true });
    Object.defineProperty(img, "naturalHeight", { value: h, writable: true });
    let _src;
    Object.defineProperty(img, "src", {
      get: () => _src,
      set(v) {
        _src = v;
        setTimeout(() => {
          if (fail) img.onerror?.();
          else img.onload?.();
        }, 0);
      },
    });
    return img;
  };
}

beforeEach(() => {
  createdUrls = [];
  revokedUrls = [];
  global.URL.createObjectURL = jest.fn(() => {
    const url = `blob:mock/${createdUrls.length}`;
    createdUrls.push(url);
    return url;
  });
  global.URL.revokeObjectURL = jest.fn((url) => {
    revokedUrls.push(url);
  });
});

afterEach(() => {
  if (origImage) {
    global.Image = origImage;
    origImage = null;
  }
});

describe("Calibrator — estado inicial", () => {
  test("renderiza el dropzone y el header con marca MIRA", () => {
    render(<Calibrator />);
    expect(screen.getByText("MIRA")).toBeInTheDocument();
    expect(screen.getByText(/Calibrador de cancha/i)).toBeInTheDocument();
    expect(screen.getByText(/Carga un frame del video/i)).toBeInTheDocument();
    expect(screen.getByText(/Ningún frame cargado/i)).toBeInTheDocument();
  });

  test("muestra las 4 esquinas en orden con la primera marcada como 'siguiente'", () => {
    render(<Calibrator />);
    expect(screen.getByText("Cercana izquierda")).toBeInTheDocument();
    expect(screen.getByText("Cercana derecha")).toBeInTheDocument();
    expect(screen.getByText("Lejana derecha")).toBeInTheDocument();
    expect(screen.getByText("Lejana izquierda")).toBeInTheDocument();
    expect(screen.getByText(/← marca esta/)).toBeInTheDocument();
  });

  test("el botón Exportar empieza deshabilitado", () => {
    render(<Calibrator />);
    expect(screen.getByRole("button", { name: /Exportar cal\.json/i })).toBeDisabled();
  });
});

describe("Calibrator — carga de archivos", () => {
  test("rechaza un archivo que no es imagen y muestra el error en la UI", async () => {
    const { container } = render(<Calibrator />);
    const input = container.querySelector('input[type="file"]');
    const notImg = new File(["bytes"], "doc.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [notImg] } });
    expect(
      await screen.findByText(/El archivo no es una imagen válida/i)
    ).toBeInTheDocument();
    // No debe haber creado object URL para archivo no-imagen
    expect(createdUrls).toHaveLength(0);
  });

  test("cargar imagen válida → crea object URL, muestra archivo y resolución", async () => {
    installImageMock({ w: 1280, h: 720 });
    const { container } = render(<Calibrator />);
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, {
      target: { files: [new File(["fake"], "frame.png", { type: "image/png" })] },
    });

    await waitFor(() => {
      expect(screen.getByText("frame.png")).toBeInTheDocument();
      expect(screen.getByText("1280 × 720")).toBeInTheDocument();
    });
    expect(createdUrls).toHaveLength(1);
  });

  test("cargar segunda imagen → revoca el URL de la primera (no hay leak)", async () => {
    installImageMock({ w: 800, h: 600 });
    const { container } = render(<Calibrator />);
    const input = container.querySelector('input[type="file"]');

    fireEvent.change(input, {
      target: { files: [new File(["a"], "a.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(screen.getByText("a.png")).toBeInTheDocument());

    fireEvent.change(input, {
      target: { files: [new File(["b"], "b.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(screen.getByText("b.png")).toBeInTheDocument());

    expect(createdUrls).toHaveLength(2);
    // La URL de la primera carga debe haber sido liberada
    expect(revokedUrls).toContain(createdUrls[0]);
  });

  test("imagen corrupta (onerror) → muestra mensaje y libera el URL", async () => {
    installImageMock({ fail: true });
    const { container } = render(<Calibrator />);
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, {
      target: { files: [new File(["bad"], "x.png", { type: "image/png" })] },
    });

    expect(
      await screen.findByText(/No se pudo decodificar la imagen/i)
    ).toBeInTheDocument();
    expect(revokedUrls).toContain(createdUrls[0]);
  });
});
