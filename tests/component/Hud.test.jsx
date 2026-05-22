/**
 * Component tests del Hud — el shell con barra de navegación.
 * Verificamos que:
 *  - Renderiza la marca MIRA y la barra de navegación
 *  - La pestaña por defecto es el calibrador y muestra su contenido
 *  - Cambiar de pestaña a "Video / Frames" muestra el dropzone de video
 *  - El subtítulo de la marca cambia con la pestaña activa
 */
import { render, screen, fireEvent } from "@testing-library/react";
import Hud from "@/components/Hud";

beforeEach(() => {
  global.URL.createObjectURL = jest.fn(() => "blob:mock");
  global.URL.revokeObjectURL = jest.fn();
});

describe("Hud — barra de navegación y pestañas", () => {
  test("renderiza la marca MIRA y los botones de navegación", () => {
    render(<Hud />);
    expect(screen.getByText("MIRA")).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: /Navegación principal/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Calibrador" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Video / Frames" })
    ).toBeInTheDocument();
  });

  test("la pestaña por defecto es Calibrador y muestra su dropzone", () => {
    render(<Hud />);
    expect(screen.getByText(/Calibrador de cancha · CLARA/i)).toBeInTheDocument();
    expect(screen.getByText(/Carga un frame del video/i)).toBeInTheDocument();
    expect(screen.getByText(/Cercana izquierda/i)).toBeInTheDocument();
  });

  test("cambiar a 'Video / Frames' muestra el dropzone de video", () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole("button", { name: "Video / Frames" }));
    expect(screen.getByText(/Carga un video/i)).toBeInTheDocument();
    expect(screen.getByText(/Extractor de frames · CLARA/i)).toBeInTheDocument();
    // Y el calibrador ya no debe estar visible
    expect(screen.queryByText(/Cercana izquierda/i)).not.toBeInTheDocument();
  });

  test("la pestaña activa se marca con aria-current=page", () => {
    render(<Hud />);
    const calBtn = screen.getByRole("button", { name: "Calibrador" });
    const vidBtn = screen.getByRole("button", { name: "Video / Frames" });
    expect(calBtn).toHaveAttribute("aria-current", "page");
    expect(vidBtn).not.toHaveAttribute("aria-current");

    fireEvent.click(vidBtn);
    expect(vidBtn).toHaveAttribute("aria-current", "page");
    expect(calBtn).not.toHaveAttribute("aria-current");
  });

  test("el <video> de Video/Frames está siempre montado: no se remonta al cargar", () => {
    // Regresión del bug raíz: dos <video> en branches distintos del JSX
    // hacían que el src se perdiera al pasar de !videoLoaded → videoLoaded,
    // dejando el reproductor en negro y rompiendo "Calibrar con este frame".
    const { container } = render(<Hud />);
    fireEvent.click(screen.getByRole("button", { name: "Video / Frames" }));
    const videoBefore = container.querySelector("video");
    expect(videoBefore).not.toBeNull();

    // Simular que llega un archivo al input
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, {
      target: { files: [new File(["x"], "v.mp4", { type: "video/mp4" })] },
    });
    // Disparar loadedmetadata sobre ese mismo <video>
    Object.defineProperty(videoBefore, "duration", { value: 5, configurable: true });
    Object.defineProperty(videoBefore, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(videoBefore, "videoHeight", { value: 480, configurable: true });
    fireEvent(videoBefore, new Event("loadedmetadata"));

    const videoAfter = container.querySelector("video");
    expect(videoAfter).toBe(videoBefore);
  });
});
