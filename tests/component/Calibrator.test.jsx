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

  test("muestra las 4 esquinas con la primera marcada como 'siguiente'", () => {
    render(<Calibrator />);
    expect(screen.getByText("Cercana izquierda")).toBeInTheDocument();
    expect(screen.getByText("Cercana derecha")).toBeInTheDocument();
    expect(screen.getByText("Lejana derecha")).toBeInTheDocument();
    expect(screen.getByText("Lejana izquierda")).toBeInTheDocument();
    expect(screen.getByText(/← marca este/)).toBeInTheDocument();
  });

  test("el botón Exportar empieza deshabilitado (0 puntos < 4)", () => {
    render(<Calibrator />);
    expect(screen.getByRole("button", { name: /Exportar cal\.json/i })).toBeDisabled();
  });

  test("muestra el contador de puntos y que faltan para el mínimo", () => {
    const { container } = render(<Calibrator />);
    expect(container.querySelector(".pts-count")).toHaveTextContent(
      "0 marcados · mínimo 4"
    );
    expect(screen.getByText(/Faltan 4 puntos/i)).toBeInTheDocument();
  });
});

describe("Calibrator — puntos de referencia flexibles", () => {
  test("cancha completa ofrece puntos internos además de las esquinas", () => {
    render(<Calibrator />);
    expect(screen.getByText("Central ∩ banda izq.")).toBeInTheDocument();
    expect(screen.getByText("Central ∩ banda der.")).toBeInTheDocument();
    expect(screen.getByText("Ataque (cerca) ∩ banda izq.")).toBeInTheDocument();
    expect(screen.getByText("Medio fondo lejano")).toBeInTheDocument();
  });

  test("cambiar a media cancha cambia el catálogo de puntos", () => {
    render(<Calibrator />);
    // En completa existe la línea central; en media no.
    expect(screen.getByText("Central ∩ banda izq.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Media 9×9/i }));
    expect(screen.queryByText("Central ∩ banda izq.")).not.toBeInTheDocument();
    expect(screen.getByText("Medio de la red")).toBeInTheDocument();
  });

  test("seleccionar un punto en la lista lo marca como 'siguiente'", () => {
    render(<Calibrator />);
    // Por defecto la esquina cercana izquierda es la seleccionada.
    fireEvent.click(screen.getByText("Lejana derecha"));
    // Esa fila ahora muestra el indicador de "marca este".
    const row = screen.getByText("Lejana derecha").closest("li");
    expect(row).toHaveClass("sel");
  });
});

describe("Calibrator — validación de resolución", () => {
  test("advierte cuando la resolución objetivo no coincide con el frame", async () => {
    installImageMock({ w: 1280, h: 720 });
    const { container } = render(<Calibrator />);
    const fileInput = container.querySelector('input[type="file"]');
    fireEvent.change(fileInput, {
      target: { files: [new File(["x"], "frame.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(screen.getByText("1280 × 720")).toBeInTheDocument());

    // El campo de resolución toma el placeholder con la resolución del frame.
    const resInput = container.querySelector('input[placeholder="1280x720"]');
    expect(resInput).toBeInTheDocument();
    fireEvent.change(resInput, { target: { value: "848x478" } });
    expect(screen.getByText(/No coincide con el frame/i)).toBeInTheDocument();

    // Si coincide, no hay advertencia.
    fireEvent.change(resInput, { target: { value: "1280x720" } });
    expect(screen.queryByText(/No coincide con el frame/i)).not.toBeInTheDocument();
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

  test("acepta imagen por extensión cuando file.type viene vacío", async () => {
    // PNG re-descargados (OneDrive, share targets, drag-drop desde el
    // explorador en algunos SO) llegan con type="" y antes los rechazábamos
    // como "no es una imagen válida".
    installImageMock({ w: 640, h: 480 });
    const { container } = render(<Calibrator />);
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, {
      target: { files: [new File(["x"], "frame.png", { type: "" })] },
    });
    await waitFor(() => {
      expect(screen.getByText("frame.png")).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/El archivo no es una imagen válida/i)
    ).not.toBeInTheDocument();
    expect(createdUrls).toHaveLength(1);
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

  test("unmount durante la decodificación: no warning ni setState fantasma", async () => {
    // Si el usuario cambia de pestaña mientras la imagen decodifica, el
    // componente se desmonta antes de img.onload. Sin la guard, React tira
    // "Can't perform state update on an unmounted component". Acá verificamos
    // que no quede esa advertencia en consola.
    installImageMock({ w: 100, h: 100 });
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { container, unmount } = render(<Calibrator />);
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, {
      target: { files: [new File(["a"], "a.png", { type: "image/png" })] },
    });
    // Desmontar ANTES del setTimeout(0) que dispara onload.
    unmount();
    await new Promise((r) => setTimeout(r, 5));
    const calls = errSpy.mock.calls.map((c) => String(c[0] || ""));
    expect(
      calls.some((m) => /unmounted component|memory leak/i.test(m))
    ).toBe(false);
    errSpy.mockRestore();
    // Y la URL debe haberse revocado en el cleanup.
    expect(revokedUrls).toContain(createdUrls[0]);
  });
});

describe("Calibrator — zoom de la lupa", () => {
  test("los botones +/− ajustan el zoom mostrado en la sección Lupa", () => {
    render(<Calibrator />);
    expect(screen.getByText("6×")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Acercar lupa/i }));
    expect(screen.getByText("7×")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Alejar lupa/i }));
    fireEvent.click(screen.getByRole("button", { name: /Alejar lupa/i }));
    expect(screen.getByText("5×")).toBeInTheDocument();
  });

  test("el zoom queda clampeado en el mínimo y deshabilita el botón", () => {
    render(<Calibrator />);
    const out = screen.getByRole("button", { name: /Alejar lupa/i });
    for (let i = 0; i < 10; i++) fireEvent.click(out);
    expect(screen.getByText("2×")).toBeInTheDocument();
    expect(out).toBeDisabled();
  });
});

describe("Calibrator — input ppm robusto", () => {
  test("ppm queda clampeado en [10,120] aún tecleando un valor fuera de rango", () => {
    const { container } = render(<Calibrator />);
    const ppmInput = container.querySelector('input[type="number"]');
    // Por encima del techo
    fireEvent.change(ppmInput, { target: { value: "9999" } });
    expect(Number(ppmInput.value)).toBe(120);
    // Por debajo del piso (pero > 0)
    fireEvent.change(ppmInput, { target: { value: "3" } });
    expect(Number(ppmInput.value)).toBe(10);
    // Cero o negativo cae al default razonable
    fireEvent.change(ppmInput, { target: { value: "0" } });
    expect(Number(ppmInput.value)).toBe(40);
  });
});
