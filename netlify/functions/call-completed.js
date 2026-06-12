exports.handler = async function (event) {
  console.log("==================== START: CALL-COMPLETED REQUEST RECEIVED ====================");

  try {
    if (event.httpMethod !== "POST") {
      console.log("Rejected non-POST request:", event.httpMethod);
      console.log("==================== END: CALL-COMPLETED REQUEST RECEIVED ====================");

      return {
        statusCode: 405,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "error",
          message: "Method not allowed. Use POST."
        })
      };
    }

    const expectedApiKey = process.env.API_SHARED_SECRET || "";
    const receivedApiKey =
      event.headers["x-api-key"] ||
      event.headers["X-API-Key"] ||
      "";

    if (!expectedApiKey || receivedApiKey !== expectedApiKey) {
      console.log("Rejected unauthorized call-completed request.");
      console.log("==================== END: CALL-COMPLETED REQUEST RECEIVED ====================");

      return {
        statusCode: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "error",
          message: "Unauthorized."
        })
      };
    }

    let payload = {};

    try {
      payload = event.body ? JSON.parse(event.body) : {};
    } catch (parseError) {
      console.log("JSON parse error:", parseError.message);
      console.log("Raw body:", event.body);
      console.log("==================== END: CALL-COMPLETED REQUEST RECEIVED ====================");

      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "error",
          message: "Invalid JSON body."
        })
      };
    }

    console.log("==================== START: RAW CALL-COMPLETED PAYLOAD ====================");
    console.log(JSON.stringify(payload, null, 2));
    console.log("==================== END: RAW CALL-COMPLETED PAYLOAD ====================");

    console.log("==================== END: CALL-COMPLETED REQUEST RECEIVED ====================");

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "received",
        message: "Call-completed payload received."
      })
    };
  } catch (error) {
    console.log("Unhandled call-completed error:", error);
    console.log("==================== END: CALL-COMPLETED REQUEST RECEIVED ====================");

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "error",
        message: "Internal server error."
      })
    };
  }
};
