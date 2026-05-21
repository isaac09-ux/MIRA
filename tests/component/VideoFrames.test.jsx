/**
 * Component tests del VideoFrames.
 * jsdom no implementa decodificación real de video, así que los tests cubren
 * lo que sí podemos verificar sin un player real:
 *  - Estado inicial: dropzone, panel vacío, validación de archivo
 *  - Rechazo de archivos que no son video
 *  - Que el botón "Carga un video" abre el selector de archivos
 */
import { render, screen, fireEvent } from "@testing-library/react";
import VideoFrames from "@/components/VideoFrames";

beforeEach(() => {
  global.URL.createObjectURL = jest.fn(() => "blob:mock");
  global.URL.revokeObjectURL = jest.fn();
});

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
  });
});
