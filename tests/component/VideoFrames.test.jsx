/**
 * Component tests del VideoFrames.
 * jsdom no implementa decodificación real de video, así que los tests cubren
 * lo que sí podemos verificar sin un player real:
 *  - Estado inicial: dropzone, panel vacío, validación de archivo
 *  - Rechazo de archivos que no son video
 *  - Regresiones: video element estable, cleanup de URLs, manejo de Infinity/NaN,
 *    onError limpia estado.
 */
import { render, screen, fireEvent, act } from "@testing-library/react";
import VideoFrames from "@/components/VideoFrames";

// URLs creadas/revocadas — para verificar que no se filtran object URLs.
let createdUrls = [];
let revokedUrls = [];

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

// Dispara loadedmetadata sobre el <video> montado con valores controlables.
function fireLoadedMetadata(container, { duration = 10, w = 1280, h = 720 } = {}) {
  const video = container.querySelector("video");
  // Definir las propiedades que React leerá desde e.target
  Object.defineProperty(video, "duration", { value: duration, configurable: true });
  Object.defineProperty(video, "videoWidth", { value: w, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: h, configurable: true });
  fireEvent(video, new Event("loadedmetadata"));
  return video;
}

describe("VideoFrames — estado inicial", () => {
  test("renderiza el dropzone con instrucciones", () => {
    render(<VideoFrames />);
    expect(screen.getByText(/Carga un video/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Arrastra un .mp4 \/ .webm \/ .mov/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/Ningún video cargado/i)).toBeInTheDocument();
  });

  test("los botones de frame actual y extraer todos empiezan deshabilitados", () => {
    render(<VideoFrames />);
    expect(
      screen.getByRole("button", { name: /Extraer este frame/i })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Calibrar con este frame/i })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Extraer todos/i })
    ).toBeDisabled();
  });

  test("el <video> está siempre montado desde el primer render (estable)", () => {
    // Regresión del bug original: antes había dos <video> en branches
    // distintos y se desmontaba/remontaba al cargar, perdiendo el src.
    const { container } = render(<VideoFrames />);
    const videos = container.querySelectorAll("video");
    expect(videos).toHaveLength(1);
  });
});

describe("VideoFrames — carga de archivos", () => {
  test("rechaza un archivo que no es video y muestra el error", () => {
    const { container } = render(<VideoFrames />);
    const input = container.querySelector('input[type="file"]');
    const notVideo = new File(["bytes"], "doc.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [notVideo] } });
    expect(
      screen.getByText(/El archivo no es un video válido/i)
    ).toBeInTheDocument();
    // No debe haber creado object URL para archivo inválido.
    expect(createdUrls).toHaveLength(0);
  });

  test("cargar un video válido revela los botones habilitados y mantiene el mismo <video>", () => {
    const { container } = render(<VideoFrames />);
    const input = container.querySelector('input[type="file"]');
    const videoBefore = container.querySelector("video");

    fireEvent.change(input, {
      target: { files: [new File(["fake"], "v.mp4", { type: "video/mp4" })] },
    });
    fireLoadedMetadata(container, { duration: 10, w: 1280, h: 720 });

    // El <video> debe ser EL MISMO nodo del DOM (no se remontó).
    const videoAfter = container.querySelector("video");
    expect(videoAfter).toBe(videoBefore);

    // El panel cambia: ahora muestra archivo, resolución, duración.
    expect(screen.getByText("v.mp4")).toBeInTheDocument();
    expect(screen.getByText("1280 × 720")).toBeInTheDocument();

    expect(
      screen.getByRole("button", { name: /Extraer este frame/i })
    ).not.toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Extraer todos/i })
    ).not.toBeDisabled();
  });
});

describe("VideoFrames — manejo robusto de eventos del <video>", () => {
  test("duration = Infinity (típico de webm sin index) no propaga NaN", () => {
    const { container } = render(<VideoFrames />);
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, {
      target: { files: [new File(["x"], "v.webm", { type: "video/webm" }) ] },
    });
    fireLoadedMetadata(container, { duration: Infinity, w: 640, h: 480 });

    // La duración debe mostrarse como 00:00.00, NO como "NaN:NaN.NaN".
    // (fmtTime convierte no-finitos a "00:00.00".)
    expect(screen.getAllByText("00:00.00").length).toBeGreaterThan(0);

    // Y "Extraer todos" mostrar un mensaje claro, no entrar en un loop NaN.
    fireEvent.click(screen.getByRole("button", { name: /Extraer todos/i }));
    expect(
      screen.getByText(/El video aún no reporta su duración/i)
    ).toBeInTheDocument();
  });

  test("currentTime = NaN del <video> no se propaga al state", () => {
    const { container } = render(<VideoFrames />);
    fireEvent.change(container.querySelector('input[type="file"]'), {
      target: { files: [new File(["x"], "v.mp4", { type: "video/mp4" })] },
    });
    fireLoadedMetadata(container, { duration: 10, w: 100, h: 100 });

    const video = container.querySelector("video");
    Object.defineProperty(video, "currentTime", { value: NaN, configurable: true });
    fireEvent(video, new Event("timeupdate"));

    // No debe aparecer "NaN" en ningún timecode.
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  test("onError del <video> limpia el estado y muestra el error", () => {
    const { container } = render(<VideoFrames />);
    fireEvent.change(container.querySelector('input[type="file"]'), {
      target: { files: [new File(["x"], "v.mp4", { type: "video/mp4" })] },
    });
    fireLoadedMetadata(container, { duration: 10, w: 1000, h: 500 });
    // Ahora el video estaba "cargado". Disparamos un error.
    const video = container.querySelector("video");
    fireEvent(video, new Event("error"));

    // Debe volver al dropzone con el mensaje de error.
    expect(
      screen.getByText(/No se pudo decodificar el video/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/Ningún video cargado/i)).toBeInTheDocument();
    // Y los botones de extracción de frame deben quedar deshabilitados.
    expect(
      screen.getByRole("button", { name: /Extraer este frame/i })
    ).toBeDisabled();
  });
});

describe("VideoFrames — cleanup de Object URLs", () => {
  test("al desmontar se revoca la URL del video cargado", () => {
    const { container, unmount } = render(<VideoFrames />);
    fireEvent.change(container.querySelector('input[type="file"]'), {
      target: { files: [new File(["x"], "v.mp4", { type: "video/mp4" })] },
    });
    expect(createdUrls).toHaveLength(1);

    act(() => unmount());

    // El cleanup del unmount debe revocar la URL del video.
    expect(revokedUrls).toContain(createdUrls[0]);
  });

  test("cargar un segundo video revoca la URL del primero (no leak)", () => {
    const { container } = render(<VideoFrames />);
    const input = container.querySelector('input[type="file"]');

    fireEvent.change(input, {
      target: { files: [new File(["a"], "a.mp4", { type: "video/mp4" })] },
    });
    fireEvent.change(input, {
      target: { files: [new File(["b"], "b.mp4", { type: "video/mp4" })] },
    });

    expect(createdUrls).toHaveLength(2);
    expect(revokedUrls).toContain(createdUrls[0]);
  });
});
