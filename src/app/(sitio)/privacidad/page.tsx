import type { Metadata } from "next";

import { LEGAL_DOCUMENTS } from "@/platform/legal";

import { SITE } from "../content";
import { LegalDocument } from "../legal-document";

export const metadata: Metadata = {
  title: "Aviso de privacidad",
  description: "Cómo tratamos y protegemos tus datos personales.",
};

const mail = (
  <a
    className="font-medium text-primary underline-offset-4 hover:underline"
    href={`mailto:${SITE.contactEmail}`}
  >
    {SITE.contactEmail}
  </a>
);

export default function PrivacyPage() {
  return (
    <LegalDocument
      eyebrow="Legal"
      title={LEGAL_DOCUMENTS.privacy.title}
      version={LEGAL_DOCUMENTS.privacy.version}
      intro={
        <p>
          Este aviso explica qué datos personales trata {SITE.name}, para qué y
          cómo puedes ejercer tus derechos, conforme a la Ley Federal de
          Protección de Datos Personales en Posesión de los Particulares.
        </p>
      }
      sections={[
        {
          id: "responsable",
          title: "Responsable",
          body: (
            <p>
              <strong>{SITE.legalName}</strong> es responsable del tratamiento
              de los datos de las personas que crean una cuenta. Contacto para
              temas de privacidad: {mail}.
            </p>
          ),
        },
        {
          id: "datos",
          title: "Datos que tratamos",
          body: (
            <ul>
              <li>
                <strong>Cuenta:</strong> nombre, correo electrónico y contraseña
                (guardada solo como huella cifrada, nunca en texto).
              </li>
              <li>
                <strong>Seguridad y accesos:</strong> dirección IP, tipo de
                dispositivo y navegador, fecha de cada inicio de sesión,
                intentos fallidos, bloqueos y la configuración de tu
                verificación en dos pasos. No determinamos tu país a partir de
                la IP.
              </li>
              <li>
                <strong>PIN de terminal compartida:</strong> si tu empresa usa
                terminales compartidas en el almacén, tu PIN se guarda solo como
                una huella derivada, nunca en claro, y se borra si te
                desactivan. También se registran las terminales (nombre y
                almacén) y los intentos de entrar con PIN.
              </li>
              <li>
                <strong>Fotos de evidencia:</strong> las que tu equipo sube al
                reportar incidencias, al completar etapas de un proceso o al
                entregar una tarea, con el nombre de quien las subió y la fecha.
              </li>
              <li>
                <strong>Empresa:</strong> nombre del negocio y las personas que
                invitas a tu equipo, con su rol, y las sesiones abiertas de cada
                persona.
              </li>
              <li>
                <strong>Contratación:</strong> plan, módulos, meses pagados y la
                referencia de tu transferencia. No recibimos ni guardamos datos
                de tarjetas.
              </li>
            </ul>
          ),
        },
        {
          id: "datos-de-clientes",
          title: "Información que capturas en el sistema",
          body: (
            <p>
              Los productos, existencias, ubicaciones, proveedores, órdenes y
              movimientos que registras pertenecen a tu empresa. Respecto de los
              datos personales que contengan (por ejemplo, el nombre, teléfono,
              RFC o correo de un proveedor), tu empresa es la responsable y{" "}
              {SITE.name} actúa como encargado: solo los tratamos para prestarte
              el servicio, incluidos los correos que nos pides enviarles
              (órdenes de compra a tus proveedores), y no los usamos para otros
              fines. Si tu empresa activa la API o los webhooks, la información
              que configure se envía al destino que tu empresa indique; desde
              ahí, su tratamiento es responsabilidad de tu empresa y de quien
              administre ese destino.
            </p>
          ),
        },
        {
          id: "fotos",
          title: "Fotos de evidencia",
          body: (
            <ul>
              <li>
                Solo las ven las personas de tu empresa que pueden ver el
                registro al que pertenecen (por ejemplo, la incidencia o la
                tarea), dentro de los almacenes y zonas que tengan asignados.
              </li>
              <li>
                Al subirlas se les quitan los metadatos que traen (ubicación GPS
                incluida), así que lo guardado no revela dónde se tomó la foto.
              </li>
              <li>
                Una foto que se sube y nunca se liga a un registro se borra
                automáticamente a las 24 horas.
              </li>
            </ul>
          ),
        },
        {
          id: "accesos",
          title: "Historial de accesos y sesiones",
          body: (
            <p>
              Guardamos un historial de accesos a tu cuenta (dispositivo y
              navegador, intentos fallidos, bloqueos y cierres de sesión) para
              que tú lo revises y para avisarte por correo si alguien entra
              desde un dispositivo nuevo o falla muchas veces. El titular, la
              administración y la gerencia de tu empresa pueden ver las sesiones
              y el historial de acceso de su equipo en esa empresa, y cerrar
              sesiones.
            </p>
          ),
        },
        {
          id: "soporte",
          title: "Acceso de soporte",
          body: (
            <p>
              Nuestro equipo no entra a la información de tu empresa salvo que
              el titular lo permita desde Configuración, por 24 horas y solo
              para consultar. El titular puede quitar ese acceso en cualquier
              momento, y cada entrada y salida queda en la bitácora de la
              empresa.
            </p>
          ),
        },
        {
          id: "finalidades",
          title: "Para qué los usamos",
          body: (
            <>
              <p>Finalidades necesarias para el servicio:</p>
              <ul>
                <li>Crear y administrar tu cuenta y la de tu empresa.</li>
                <li>
                  Verificar tu identidad, proteger el acceso y prevenir abusos
                  (límites de intentos, avisos de seguridad).
                </li>
                <li>
                  Enviarte correos del servicio: confirmación, recuperación de
                  contraseña, invitaciones y avisos de cambios importantes. Los
                  avisos de operación por correo y el resumen diario son
                  opcionales y cada persona los activa por su cuenta.
                </li>
                <li>Registrar tu pago, facturar y darte soporte.</li>
                <li>Cumplir obligaciones legales.</li>
              </ul>
              <p>
                No vendemos tus datos ni los usamos para publicidad de terceros.
              </p>
            </>
          ),
        },
        {
          id: "cookies",
          title: "Cookies y almacenamiento local",
          body: (
            <ul>
              <li>
                <strong>Sesión:</strong> una cookie necesaria para mantenerte
                dentro de tu cuenta. Se borra al cerrar sesión o al vencer.
              </li>
              <li>
                <strong>Confirmación de correo:</strong> una cookie temporal
                mientras confirmas tu dirección.
              </li>
              <li>
                <strong>Preferencias:</strong> tu elección de modo claro u
                oscuro se guarda solo en tu navegador.
              </li>
            </ul>
          ),
        },
        {
          id: "transferencias",
          title: "Con quién los compartimos",
          body: (
            <>
              <p>
                Solo con proveedores que nos ayudan a operar el servicio, para
                esos fines, y con autoridades cuando la ley lo exija:
              </p>
              <ul>
                <li>
                  Hospedaje de la aplicación y la base de datos: el proveedor de
                  servidores que contratemos.
                </li>
                <li>
                  Almacenamiento de archivos (fotos y archivos importados): un
                  proveedor externo compatible con S3, Cloudflare R2.
                </li>
                <li>Envío de correo: el servidor de correo del servicio.</li>
              </ul>
              <p>
                Algunos de estos proveedores guardan información fuera de
                México.
              </p>
            </>
          ),
        },
        {
          id: "arco",
          title: "Tus derechos (ARCO)",
          body: (
            <>
              <p>
                Puedes acceder a tus datos, rectificarlos, cancelarlos u
                oponerte a su tratamiento, así como revocar tu consentimiento,
                escribiendo a {mail} desde el correo de tu cuenta. Indica tu
                nombre, el derecho que quieres ejercer y, si aplica, qué dato
                corregir.
              </p>
              <p>
                Te responderemos dentro de los plazos que marca la ley. Algunos
                datos deben conservarse por obligaciones legales o para la
                seguridad de la cuenta (por ejemplo, la bitácora).
              </p>
            </>
          ),
        },
        {
          id: "seguridad",
          title: "Cómo los protegemos",
          body: (
            <ul>
              <li>Conexión cifrada y contraseñas con huella resistente.</li>
              <li>
                Verificación en dos pasos, obligatoria para titulares y
                administradores.
              </li>
              <li>Separación estricta entre empresas y permisos por rol.</li>
              <li>Bitácora de cambios sensibles que no se puede alterar.</li>
              <li>
                Respaldos cifrados y revisiones de seguridad periódicas. Los
                archivos se sirven siempre a través del sistema, con permiso de
                quien los pide.
              </li>
              <li>
                Los PIN de terminal compartida se guardan derivados y solo
                funcionan en una terminal registrada.
              </li>
            </ul>
          ),
        },
        {
          id: "cambios",
          title: "Cambios a este aviso",
          body: (
            <p>
              Publicaremos cualquier cambio en esta página con su fecha. Si el
              cambio es importante, te avisaremos por correo antes de que
              aplique.
            </p>
          ),
        },
      ]}
    />
  );
}
