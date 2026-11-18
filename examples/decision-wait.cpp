#include <iostream>
#include <regex>
#include <string>

int main() {
    std::string request;
    if (!std::getline(std::cin, request)) return 1;

    // The framework supplies UUID request IDs and integer observation versions.
    const std::regex id(R"json("requestId"\s*:\s*"([0-9a-f-]{36})")json");
    const std::regex version(R"json("observationVersion"\s*:\s*([0-9]+))json");
    std::smatch requestId;
    std::smatch observationVersion;
    if (!std::regex_search(request, requestId, id) ||
        !std::regex_search(request, observationVersion, version)) return 2;

    std::cout << "{\"apiVersion\":1,\"requestId\":\"" << requestId[1]
              << "\",\"observationVersion\":" << observationVersion[1]
              << ",\"status\":\"wait\"}\n";
}
