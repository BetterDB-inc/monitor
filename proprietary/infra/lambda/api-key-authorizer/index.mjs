import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const ssm = new SSMClient();
let cachedKey;

export const handler = async (event) => {
    const apiKey = event.headers?.["x-api-key"];

    if (!apiKey) {
        return { isAuthorized: false };
    }

    if (!cachedKey) {
        const res = await ssm.send(
            new GetParameterCommand({
                Name: process.env.SSM_PARAM_NAME,
                WithDecryption: true,
            })
        );
        cachedKey = res.Parameter.Value;
    }

    return { isAuthorized: apiKey === cachedKey };
};