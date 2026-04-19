import type { FastifyInstance } from "fastify";
import type { ProviderKind, ProviderTransportKind } from "@aliceloop/runtime-core";
import { fetchProviderModels } from "../providers/providerModelCatalogService";
import { getProviderConfig, listProviderConfigs, updateProviderConfig } from "../repositories/providerRepository";

interface ProviderParams {
  id: ProviderKind;
}

interface UpdateProviderBody {
  transport?: ProviderTransportKind;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  enabled?: boolean;
}

export function registerProviderRoutes(server: FastifyInstance) {
  server.get("/api/providers", async () => listProviderConfigs());

  server.get<{ Params: ProviderParams }>("/api/providers/:id", async (request) => {
    return getProviderConfig(request.params.id);
  });

  server.get<{ Params: ProviderParams }>("/api/providers/:id/models", async (request, reply) => {
    try {
      return await fetchProviderModels(request.params.id);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "provider_api_key_required") {
          return reply.code(409).send({
            error: "provider_api_key_required",
          });
        }

        if (error.message.startsWith("provider_models_fetch_failed:")) {
          return reply.code(502).send({
            error: "provider_models_fetch_failed",
            detail: error.message,
          });
        }
      }

      throw error;
    }
  });

  server.put<{ Params: ProviderParams; Body: UpdateProviderBody }>("/api/providers/:id", async (request) => {
    return updateProviderConfig({
      providerId: request.params.id,
      ...request.body,
    });
  });
}
